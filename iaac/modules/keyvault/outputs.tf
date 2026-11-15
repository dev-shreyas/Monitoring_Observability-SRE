# Deliberately sourced from time_sleep rather than azurerm_key_vault.main.id directly.
# The value is identical, but reading it through the sleep makes every module that
# consumes key_vault_id (sql, servicebus) wait for the Secrets Officer role assignments
# to exist AND to propagate before it writes a secret. Pointing this back at
# azurerm_key_vault.main.id would silently reintroduce the 403 ForbiddenByRbac race.
output "key_vault_id" {
  value = time_sleep.wait_for_rbac.triggers["key_vault_id"]
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "key_vault_uri" {
  value = azurerm_key_vault.main.vault_uri
}

# Goes on the Kubernetes ServiceAccount as the annotation
#   azure.workload.identity/client-id
# This is the CLIENT id, not the principal/object id — the wrong one of the two is a
# common and confusing failure, since the pod then fails token exchange at runtime.
output "workload_identity_client_ids" {
  value       = { for k, v in azurerm_user_assigned_identity.workload_identity : k => v.client_id }
  description = "Map of service name -> client ID. Each service's ServiceAccount gets its own value in the azure.workload.identity/client-id annotation; they are NOT interchangeable."
}

output "workload_identity_names" {
  value = { for k, v in azurerm_user_assigned_identity.workload_identity : k => v.name }
}
