data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "keyvault" {
  name     = "rg-${var.project}-kv-${var.environment}"
  location = var.location
}

resource "azurerm_key_vault" "main" {
  name                = "kv-${var.project}-${var.environment}-${random_string.kv_key.result}"
  location            = var.location
  resource_group_name = azurerm_resource_group.keyvault.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  # Note: was previously off for dev so the vault can be destroyed/recreated cleanly.
  # Now true — once applied, this vault can't be purged for soft_delete_retention_days.
  purge_protection_enabled   = true
  soft_delete_retention_days = 7

  rbac_authorization_enabled = true # Azure RBAC, not legacy access policies

  # Terraform writes secrets (the SQL admin password, the Service Bus connection string)
  # over the vault's DATA plane. With public access disabled, the data plane is reachable
  # only from inside the VNet via private endpoint — and Terraform running on a laptop or
  # a hosted CI agent is not inside that VNet, so those writes fail with
  # "ForbiddenByConnection" no matter what RBAC roles are assigned.
  #
  # To close this off properly later: add a Key Vault private endpoint (privatelink.
  # vaultcore.azure.net) in modules/pvt-endpoints, run Terraform from an agent inside the
  # VNet, then set public_network_access_enabled = false.
  public_network_access_enabled = var.public_network_access_enabled

  network_acls {
    bypass = "AzureServices"
    # Leaving allowed_ip_rules empty keeps this open so the deploying machine can reach
    # the data plane. Populate it (e.g. with your egress IP) and this switches to
    # deny-by-default automatically, allowing only those addresses.
    default_action = length(var.allowed_ip_rules) > 0 ? "Deny" : "Allow"
    ip_rules       = var.allowed_ip_rules
  }
}

resource "random_string" "kv_key" {
  length  = 5
  special = false
  upper   = false
  lower   = true
}

# No azurerm_key_vault_access_policy here on purpose: this vault has
# rbac_authorization_enabled = true, and Azure rejects access-policy writes against
# an RBAC-enabled vault outright ("Access policy is not supported when RBAC
# authorization is enabled"). The azurerm_role_assignment below is the RBAC-mode
# equivalent — it already grants the deploying identity everything an access policy
# would have, the correct way for this vault's auth mode.

# Workload Identity: lets a pod read Key Vault secrets using its Kubernetes service
# account token, with no client secret stored anywhere (guide section 16).
#
# A dedicated identity on purpose — deliberately NOT the AKS cluster identity and not
# the principal Terraform runs as. Those two are far more privileged, and a pod that
# borrowed either would inherit everything they can do.
resource "azurerm_user_assigned_identity" "workload_identity" {
  for_each = var.workload_identities

  name                = "uai-workload-${each.key}-${var.environment}"
  location            = var.location
  resource_group_name = azurerm_resource_group.keyvault.name
}

locals {
  workload_namespace = var.workload_namespace != "" ? var.workload_namespace : "ecommerce-${var.environment}"
}

# Tells Azure AD to trust tokens issued by this specific cluster for this specific
# service account, and hand back a token for the identity above.
#
# The subject must match the pod's service account EXACTLY, in the form
# system:serviceaccount:<namespace>:<name>. Any mismatch fails at runtime with
# AADSTS70021 (no matching federated identity record found) — nothing catches it at
# plan time, because Azure AD accepts any string here.
#
# The Kubernetes side is not managed by Terraform. The ServiceAccount must exist and
# carry the client-id annotation, and the pod must be labelled for Workload Identity:
#
#   apiVersion: v1
#   kind: ServiceAccount
#   metadata:
#     name: order-service-sa
#     namespace: ecommerce-dev
#     annotations:
#       azure.workload.identity/client-id: <workload_identity_client_id output>
#   ---
#   # in the Deployment's pod template:
#   metadata:
#     labels:
#       azure.workload.identity/use: "true"
#     spec:
#       serviceAccountName: order-service-sa
resource "azurerm_federated_identity_credential" "workload_identity" {
  for_each = var.workload_identities

  name                      = "fed-${each.key}-${var.environment}"
  issuer                    = var.aks_oidc_issuer_url
  subject                   = "system:serviceaccount:${local.workload_namespace}:${each.value}"
  audience                  = ["api://AzureADTokenExchange"]
  user_assigned_identity_id = azurerm_user_assigned_identity.workload_identity[each.key].id
}

# The federated credential only establishes WHO the pod is. It grants no access by
# itself — without this the pod authenticates successfully and then gets 403 on every
# secret read. "Secrets User" is read-only, which is all an application should need;
# the "Secrets Officer" grants above (write access) are for Terraform and humans.
#
# Scoped to the whole vault for now, so every service can read every secret. Tightening
# this to per-secret scope is possible (scope = azurerm_key_vault_secret.<x>.resource_id)
# and is the natural next step once the secret-to-service mapping settles.
resource "azurerm_role_assignment" "workload_secrets_user" {
  for_each = var.workload_identities

  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.workload_identity[each.key].principal_id
}

# Since the vault uses RBAC authorization, the identity running Terraform needs an
# explicit role grant here too, or the sql module's azurerm_key_vault_secret write fails.
resource "azurerm_role_assignment" "deployer_secrets_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# The grant above covers only the identity Terraform runs as (the service principal).
# Humans browsing the vault in the portal need their own data-plane role — being
# subscription Owner is not enough on an RBAC-enabled vault. Keeping this in Terraform
# means the grant is recreated automatically if the vault is ever rebuilt (its name
# carries a random suffix, so a hand-made assignment would be lost).
resource "azurerm_role_assignment" "secrets_admins" {
  # Exclude whoever is running Terraform — deployer_secrets_officer above already grants
  # that principal this exact role at this exact scope. Azure rejects duplicate
  # assignments with a 409, so listing yourself in secrets_admin_object_ids while also
  # being the deployer would otherwise break every apply.
  for_each = toset(setsubtract(var.secrets_admin_object_ids, [data.azurerm_client_config.current.object_id]))

  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# Azure RBAC grants are not effective the instant the API call returns — the assignment
# has to propagate to the Key Vault data plane, which takes anywhere from a few seconds
# to a couple of minutes. Until it lands, a secret write fails with:
#
#   403 ForbiddenByRbac ... Action: 'Microsoft.KeyVault/vaults/secrets/getSecret/action'
#   Assignment: (not found)
#
# "(not found)" reads like the grant is missing, but it means the data plane cannot see
# it *yet*. Nothing is wrong with the role assignment itself.
#
# Ordering alone does not fix this, and ordering was also missing: the secret writes live
# in modules/sql and modules/servicebus, which depend only on the vault's id. Terraform
# therefore considered them free to run concurrently with the role assignment above.
#
# Routing key_vault_id through this resource (see outputs.tf) solves both halves — it
# forces every consumer of the output to wait for the role assignments, then adds the
# propagation delay on top.
resource "time_sleep" "wait_for_rbac" {
  depends_on = [
    azurerm_role_assignment.deployer_secrets_officer,
    azurerm_role_assignment.secrets_admins,
  ]

  create_duration = "120s"

  # Carries the vault id through so outputs.tf can expose it from here, creating a real
  # data dependency rather than relying on depends_on in the output block.
  triggers = {
    key_vault_id = azurerm_key_vault.main.id
  }
}
# Application-level secret, not tied to any Azure resource, so it lives here rather than
# in a service module. Terraform generates it: nobody ever needs to see or type it, and a
# hand-picked value would be weaker and would end up pasted somewhere it shouldn't be.
#
# 64 chars, no special characters -- the value gets embedded in HTTP headers, env vars and
# config files, where shell-escaping bugs around punctuation are a recurring source of
# "works locally, fails in the cluster". 64 alphanumerics is ~380 bits of entropy, far
# beyond what HS256 needs.
#
# Rotating it invalidates every token already issued, logging all users out. Both
# user-service, order-service and product-service read it as JWT_SECRET.
resource "random_password" "jwt_signing_key" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "jwt_signing_key" {
  name         = "jwt-signing-key"
  value        = random_password.jwt_signing_key.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [time_sleep.wait_for_rbac]
}

# Service-to-service token for the /internal APIs (stock reservations in product-service,
# order transitions in order-service). Read as INTERNAL_API_TOKEN by both; each refuses to
# start in production without a value of at least 32 characters.
resource "random_password" "internal_api_token" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "internal_api_token" {
  name         = "internal-api-token"
  value        = random_password.internal_api_token.result
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [time_sleep.wait_for_rbac]
}
