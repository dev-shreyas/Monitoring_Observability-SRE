terraform {
  # Only non-sensitive, environment-independent settings live here.
  # Auth (subscription_id, tenant_id, client_id, client_secret) is supplied at
  # `terraform init` time via ARM_* environment variables — see infra/README or
  # the project runbook. Never put credentials in this file; it's version-controlled.
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "sttfstateecommerce01"
    container_name       = "tfstate"
    key                  = "ecommerce.prod.tfstate"
  }
}