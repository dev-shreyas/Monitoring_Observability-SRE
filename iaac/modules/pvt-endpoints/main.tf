# ---------------------------------------------------------------------------
# Azure SQL — private endpoint + private DNS zone
# ---------------------------------------------------------------------------
resource "azurerm_private_endpoint" "sql" {
  name                = "pe-sql-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.pe_subnet_id

  private_service_connection {
    name                           = "psc-sql-${var.project}-${var.environment}"
    private_connection_resource_id = var.sql_server_id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "sql-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.sql.id]
  }
}

resource "azurerm_private_dns_zone" "sql" {
  name                = "privatelink.database.windows.net"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "sql" {
  name                = "sql-dns-link-${var.environment}"
  private_dns_zone_id = azurerm_private_dns_zone.sql.id
  virtual_network_id  = var.vnet_id
}

# ---------------------------------------------------------------------------
# Cosmos DB — private endpoint + private DNS zone
# ---------------------------------------------------------------------------
resource "azurerm_private_endpoint" "cosmosdb" {
  name                = "pe-cosmos-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.pe_subnet_id

  private_service_connection {
    name                           = "psc-cosmos-${var.project}-${var.environment}"
    private_connection_resource_id = var.cosmosdb_account_id
    subresource_names              = ["Sql"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "cosmos-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.cosmosdb.id]
  }
}

resource "azurerm_private_dns_zone" "cosmosdb" {
  name                = "privatelink.documents.azure.com"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "cosmosdb" {
  name                = "cosmos-dns-link-${var.environment}"
  private_dns_zone_id = azurerm_private_dns_zone.cosmosdb.id
  virtual_network_id  = var.vnet_id
}

# ---------------------------------------------------------------------------
# Key Vault and ACR follow the exact same pattern (privatelink.vaultcore.azure.net
# and privatelink.azurecr.io respectively) — add them here once those resources
# exist as modules in this repo. Right now sql/main.tf only references an
# existing Key Vault via a data source, and there is no acr module yet.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------------
# Key Vault
# ---------------------------------------------------------------------------------
# Note what linking this DNS zone does: EVERYTHING in the VNet now resolves the vault's
# hostname to a private 10.10.2.x address, AKS nodes included. That is the goal -- the
# CSI driver's secret reads stop traversing the public endpoint -- but it means the
# private endpoint must be healthy or every secret mount fails. It also does NOT close
# the public endpoint; that is public_network_access_enabled on the vault itself, which
# stays true while Terraform runs from outside the VNet.
resource "azurerm_private_endpoint" "keyvault" {
  count = var.key_vault_private_endpoint_enabled ? 1 : 0

  name                = "pe-kv-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.pe_subnet_id

  private_service_connection {
    name                           = "psc-kv"
    private_connection_resource_id = var.key_vault_id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "kv-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.keyvault[0].id]
  }
}

resource "azurerm_private_dns_zone" "keyvault" {
  count = var.key_vault_private_endpoint_enabled ? 1 : 0

  name                = "privatelink.vaultcore.azure.net"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "keyvault" {
  count = var.key_vault_private_endpoint_enabled ? 1 : 0

  name                 = "kv-dns-link"
  private_dns_zone_id  = azurerm_private_dns_zone.keyvault[0].id
  virtual_network_id   = var.vnet_id
  registration_enabled = false
}

# ---------------------------------------------------------------------------------
# Blob Storage
# ---------------------------------------------------------------------------------
resource "azurerm_private_endpoint" "blob" {
  count = var.blob_private_endpoint_enabled ? 1 : 0

  name                = "pe-blob-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.pe_subnet_id

  private_service_connection {
    name                           = "psc-blob"
    private_connection_resource_id = var.storage_account_id
    # "blob" specifically: a storage account has a separate subresource (and separate
    # private endpoint) per service -- file, queue, table, dfs. Only blob is needed here.
    subresource_names    = ["blob"]
    is_manual_connection = false
  }

  private_dns_zone_group {
    name                 = "blob-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.blob[0].id]
  }
}

resource "azurerm_private_dns_zone" "blob" {
  count = var.blob_private_endpoint_enabled ? 1 : 0

  name                = "privatelink.blob.core.windows.net"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "blob" {
  count = var.blob_private_endpoint_enabled ? 1 : 0

  name                 = "blob-dns-link"
  private_dns_zone_id  = azurerm_private_dns_zone.blob[0].id
  virtual_network_id   = var.vnet_id
  registration_enabled = false
}

# ---------------------------------------------------------------------------------
# Azure Container Registry -- OFF by default, and it is not a style choice
# ---------------------------------------------------------------------------------
# ACR private endpoints require the PREMIUM SKU. This registry is Standard, so enabling
# this without upgrading fails the apply. Premium is roughly 5x the Standard price, which
# is why it is gated behind a variable rather than simply switched on: it is a real
# monthly cost decision, not a config toggle.
#
# To turn it on: set the acr module's sku to "Premium", then acr_private_endpoint_enabled
# to true here. Be aware the DNS zone link makes every node resolve the registry
# privately, so image pulls break if the endpoint is unhealthy.
resource "azurerm_private_endpoint" "acr" {
  count = var.acr_private_endpoint_enabled ? 1 : 0

  name                = "pe-acr-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.pe_subnet_id

  private_service_connection {
    name                           = "psc-acr"
    private_connection_resource_id = var.acr_id
    subresource_names              = ["registry"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "acr-dns-zone-group"
    private_dns_zone_ids = [azurerm_private_dns_zone.acr[0].id]
  }
}

resource "azurerm_private_dns_zone" "acr" {
  count = var.acr_private_endpoint_enabled ? 1 : 0

  name                = "privatelink.azurecr.io"
  resource_group_name = var.resource_group_name
}

resource "azurerm_private_dns_zone_virtual_network_link" "acr" {
  count = var.acr_private_endpoint_enabled ? 1 : 0

  name                 = "acr-dns-link"
  private_dns_zone_id  = azurerm_private_dns_zone.acr[0].id
  virtual_network_id   = var.vnet_id
  registration_enabled = false
}
