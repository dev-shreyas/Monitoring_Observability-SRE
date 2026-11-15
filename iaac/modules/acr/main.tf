resource "random_string" "acr_key" {
  length  = 5
  special = false
  upper   = false
  lower   = true
}

resource "azurerm_resource_group" "acr" {
  name     = "rg-${var.project}-acr-${var.environment}-${random_string.acr_key.result}"
  location = var.location
}

resource "azurerm_container_registry" "acr" {
  # ACR names are globally unique across Azure and alphanumeric only — no hyphens,
  # no underscores, nothing but letters and digits.
  name                = "acr${var.project}${var.environment}${random_string.acr_key.result}"
  resource_group_name = azurerm_resource_group.acr.name
  location            = var.location
  sku                 = "Standard"
  admin_enabled       = false # AKS pulls via managed identity + AcrPull role, not admin credentials
}
