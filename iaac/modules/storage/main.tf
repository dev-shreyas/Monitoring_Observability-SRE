# Blob Storage for product images and static assets (guide sections 3 and 5). The guide's
# folder layout lists a storage module but never defines one, so this fills that gap.

resource "azurerm_resource_group" "storage" {
  name     = "rg-${var.project}-storage-${var.environment}"
  location = var.location
}

# Storage account names are globally unique, 3-24 characters, lowercase alphanumeric ONLY
# -- no hyphens, unlike every other resource here. Same random-suffix pattern as acr,
# keyvault, cosmos and sql; lower() guards against a mixed-case project/environment value.
resource "random_string" "storage_key" {
  length  = 6
  special = false
  upper   = false
  lower   = true
}

resource "azurerm_storage_account" "main" {
  name                = lower("st${var.project}${var.environment}${random_string.storage_key.result}")
  resource_group_name = azurerm_resource_group.storage.name
  location            = var.location

  account_tier             = "Standard"
  account_replication_type = var.account_replication_type
  account_kind             = "StorageV2"

  # TLS 1.2 minimum and no unencrypted transport. Both are the current Azure defaults,
  # set explicitly so a provider default change cannot silently weaken them.
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false

  # Blob access happens over the data plane, same as Key Vault -- Terraform running
  # outside the VNet needs this true to create containers. Set false once a private
  # endpoint exists and Terraform runs from inside the VNet.
  public_network_access_enabled = var.public_network_access_enabled

  blob_properties {
    # Recovers blobs deleted by accident or by a buggy deploy. Cheap insurance: you pay
    # for the retained bytes only for the retention window.
    delete_retention_policy {
      days = 7
    }
    versioning_enabled = true
  }

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# Private container. The guide serves images through Front Door/CDN rather than directly
# from Blob, so nothing needs anonymous public read -- the CDN authenticates to the origin.
# Making this "blob" (public read) is the single most common way a storage account ends up
# indexed by search engines.
resource "azurerm_storage_container" "product_images" {
  name                  = "product-images"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "static_assets" {
  name                  = "static-assets"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Lets the product-service workload identity read and write images without a storage key.
# Same Workload Identity model as Key Vault: no credential stored anywhere. Empty by
# default so the module is usable before those identities exist.
resource "azurerm_role_assignment" "blob_contributors" {
  for_each = toset(var.blob_contributor_principal_ids)

  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}
