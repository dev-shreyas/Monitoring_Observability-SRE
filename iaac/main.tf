# Root wiring: connects every module together for one environment.
# Which environment this deploys is driven entirely by var.environment (see variables.tf) —
# pass -var-file for staging/prod, or split into infra/environments/<env>/ with its own
# backend.tf later if these need separate state files.

module "networking" {
  source = "./modules/networking"

  project     = var.project
  environment = var.environment
  location    = var.location
}

module "acr" {
  source = "./modules/acr"

  project     = var.project
  environment = var.environment
  location    = var.location
}

module "keyvault" {
  source = "./modules/keyvault"

  project                  = var.project
  environment              = var.environment
  location                 = var.location
  secrets_admin_object_ids = var.keyvault_secrets_admin_object_ids

  # Creates a keyvault -> aks dependency, which is safe: aks depends on networking,
  # monitoring and acr, never on keyvault, so there is no cycle. It does mean the vault
  # (and therefore the sql and servicebus secret writes downstream of it) now waits for
  # the cluster to finish provisioning.
  aks_oidc_issuer_url = module.aks.oidc_issuer_url
}

module "monitoring" {
  source = "./modules/monitoring"

  project      = var.project
  environment  = var.environment
  location     = var.location
  key_vault_id = module.keyvault.key_vault_id
  alert_email  = var.alert_email
}

module "storage" {
  source = "./modules/storage"

  project     = var.project
  environment = var.environment
  location    = var.location

  # Blob Storage for product images and static assets. The guide's folder layout lists a
  # storage module but never defines one.
  blob_contributor_principal_ids = var.storage_blob_contributor_principal_ids
}

module "sql" {
  source = "./modules/sql"

  project             = var.project
  environment         = var.environment
  location            = var.location
  key_vault_id        = module.keyvault.key_vault_id
  aad_admin_object_id = var.aad_admin_object_id
}

module "cosmos" {
  source = "./modules/cosmos"

  project      = var.project
  environment  = var.environment
  location     = var.location
  key_vault_id = module.keyvault.key_vault_id
}

module "servicebus" {
  source = "./modules/servicebus"

  project      = var.project
  environment  = var.environment
  location     = var.location
  key_vault_id = module.keyvault.key_vault_id
}

module "aks" {
  source = "./modules/aks"

  project                  = var.project
  environment              = var.environment
  location                 = var.location
  kubernetes_version       = var.kubernetes_version
  subnet_id                = module.networking.aks_subnet_id
  log_analytics            = module.monitoring.log_analytics_workspace_id
  acr_id                   = module.acr.acr_id
  cluster_admin_object_ids = var.aks_cluster_admin_object_ids

  api_server_authorized_ip_ranges = var.aks_api_server_authorized_ip_ranges
}

# The jumpbox module was removed when the cluster moved from private to public. It only
# ever existed because a private cluster's API FQDN resolves inside the VNet alone, so
# kubectl needed a VM in that VNet — at the cost of 2 of the subscription's 4 regional
# vCPUs. A public API server is reachable directly, so the VM has no remaining purpose.
# The module was never committed, so there is no git history to recover it from — if the
# cluster ever goes back to private_cluster_enabled, it has to be rewritten.

module "pvt_endpoints" {
  source = "./modules/pvt-endpoints"

  project             = var.project
  environment         = var.environment
  location            = var.location
  resource_group_name = module.networking.resource_group_name
  vnet_id             = module.networking.vnet_id
  pe_subnet_id        = module.networking.pe_subnet_id
  sql_server_id       = module.sql.sql_server_id
  cosmosdb_account_id = module.cosmos.cosmosdb_account_id

  key_vault_id       = module.keyvault.key_vault_id
  storage_account_id = module.storage.storage_account_id

  # Needs a Premium ACR; this registry is Standard. See the comment in the module.
  acr_id                       = module.acr.acr_id
  acr_private_endpoint_enabled = var.acr_private_endpoint_enabled
}
