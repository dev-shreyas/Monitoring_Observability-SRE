resource "azurerm_resource_group" "cosmosdb" {
  name     = "rg-${var.project}-cosmos-${var.environment}"
  location = var.location
}

resource "azurerm_cosmosdb_account" "cosmosdb" {
  # Cosmos DB account names must be all lowercase — lower(...) protects this even if
  # var.project/var.environment are ever set to a mixed-case value.
  name                = lower("cosmos-${var.project}-${var.environment}-${random_string.cosmosdb_key.result}")
  location            = var.location
  resource_group_name = azurerm_resource_group.cosmosdb.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level       = "Session"
    max_interval_in_seconds = 5
    max_staleness_prefix    = 100
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  public_network_access_enabled     = false
  is_virtual_network_filter_enabled = true

  capabilities {
    name = "EnableServerless"
  }
}

resource "random_string" "cosmosdb_key" {
  length  = 6
  special = false
  upper   = false
  lower   = true
}

resource "azurerm_cosmosdb_sql_database" "catalog" {
  name                = "catalog"
  resource_group_name = azurerm_resource_group.cosmosdb.name
  account_name        = azurerm_cosmosdb_account.cosmosdb.name
}

resource "azurerm_cosmosdb_sql_container" "products" {
  name                = "products"
  resource_group_name = azurerm_resource_group.cosmosdb.name
  account_name        = azurerm_cosmosdb_account.cosmosdb.name
  database_name       = azurerm_cosmosdb_sql_database.catalog.name
  partition_key_paths = ["/category"]
  throughput          = null
}
# The application reads Cosmos through this connection string rather than being handed
# the account key directly. Marked sensitive implicitly by Terraform because
# primary_sql_connection_string embeds the account key.
#
# A connection string means key-based auth, which is a step down from the Workload
# Identity used for Key Vault itself: keys are long-lived, shared, and grant full account
# access. The stronger option is RBAC data-plane access for the workload identity
# (Cosmos DB Built-in Data Contributor) with the SDK authenticating via DefaultAzure
# Credential -- worth moving to once the app code supports it.
resource "azurerm_key_vault_secret" "cosmos_connection_string" {
  name         = "cosmos-connection-string"
  value        = azurerm_cosmosdb_account.cosmosdb.primary_sql_connection_string
  key_vault_id = var.key_vault_id
}

# product-service reads COSMOS_ENDPOINT and COSMOS_KEY as separate values (see
# services/product-service/src/config.ts) -- it never parses a connection string. Storing
# them separately means the app gets exactly what it expects, and the endpoint (not
# sensitive) stays distinguishable from the key (very much sensitive).
resource "azurerm_key_vault_secret" "cosmos_endpoint" {
  name         = "cosmos-endpoint"
  value        = azurerm_cosmosdb_account.cosmosdb.endpoint
  key_vault_id = var.key_vault_id
}

resource "azurerm_key_vault_secret" "cosmos_key" {
  name         = "cosmos-key"
  value        = azurerm_cosmosdb_account.cosmosdb.primary_key
  key_vault_id = var.key_vault_id
}
