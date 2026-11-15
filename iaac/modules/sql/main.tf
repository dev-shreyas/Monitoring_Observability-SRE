resource "azurerm_resource_group" "sql" {
  name     = "rg-${var.project}-sql-${var.environment}"
  location = var.location
}

resource "random_string" "sql_key" {
  length  = 5
  special = false
  upper   = false
  lower   = true
}

resource "azurerm_mssql_server" "sql_server" {
  # The server name becomes a globally unique DNS name (<name>.database.windows.net),
  # so a generic "sql-ecommerce-dev" collides with someone else's server. The random
  # suffix makes it unique, same pattern as the acr/keyvault/cosmos/servicebus modules.
  # lower() because SQL server names must be lowercase.
  name                         = lower("sql-${var.project}-${var.environment}-${random_string.sql_key.result}")
  resource_group_name          = azurerm_resource_group.sql.name
  location                     = var.location
  version                      = "12.0"
  administrator_login          = var.sql_admin_username
  administrator_login_password = random_password.sql_admin_password.result

  azuread_administrator {
    login_username = var.aad_admin_login_username
    object_id      = var.aad_admin_object_id
  }

  public_network_access_enabled = false
}

resource "random_password" "sql_admin_password" {
  length  = 16
  special = true
}

# zone_redundant / storage_account_type = "Zone" are both zone-redundancy features, and
# this subscription rejects them ("Provisioning of zone redundant database/pool is not
# supported for your current request"). Turn them on for staging/prod on a subscription
# that permits it — zone redundancy is what protects these databases from a single
# datacenter failure, so it matters for anything beyond dev.
resource "azurerm_mssql_database" "sql_database" {
  name                 = "db-users"
  server_id            = azurerm_mssql_server.sql_server.id
  collation            = "SQL_Latin1_General_CP1_CI_AS"
  sku_name             = "GP_Gen5_2"
  zone_redundant       = false
  max_size_gb          = 10
  storage_account_type = "Local"
}

resource "azurerm_mssql_database" "sql_database_orders" {
  name                 = "db-orders"
  server_id            = azurerm_mssql_server.sql_server.id
  collation            = "SQL_Latin1_General_CP1_CI_AS"
  sku_name             = "GP_Gen5_2"
  zone_redundant       = false
  max_size_gb          = 10
  storage_account_type = "Local"
}

resource "azurerm_key_vault_secret" "sql_admin_password_secret" {
  name         = "sql-admin-password"
  value        = random_password.sql_admin_password.result
  key_vault_id = var.key_vault_id
}

# A ready-to-use connection string, which is what the application consumes — the bare
# password above is not enough on its own, since the app would still need the server
# FQDN and database name from somewhere.
#
# Points at db-orders because order-service owns orders. A service needing db-users
# wants its own secret rather than this one; sharing a connection string across services
# means they also share a credential and a blast radius.
#
# Encrypt=True is required: Azure SQL refuses unencrypted connections. Note the server
# has public_network_access_enabled = false, so this only resolves from inside the VNet
# via the private endpoint in modules/pvt-endpoints.
# Separate secret for user-service, pointing at db-users. Deliberately NOT reusing
# sql-connection-string: that one names db-orders, so user-service consuming it would
# silently connect to the wrong database — the connection succeeds, the tables are just
# missing or wrong, which is a far more confusing failure than a connection error.
resource "azurerm_key_vault_secret" "sql_users_connection_string" {
  name = "sql-users-connection-string"
  value = join("", [
    "Server=tcp:${azurerm_mssql_server.sql_server.fully_qualified_domain_name},1433;",
    "Initial Catalog=${azurerm_mssql_database.sql_database.name};",
    "User ID=${var.sql_admin_username};",
    "Password=${random_password.sql_admin_password.result};",
    "Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;",
  ])
  key_vault_id = var.key_vault_id
}

resource "azurerm_key_vault_secret" "sql_connection_string" {
  name = "sql-connection-string"
  value = join("", [
    "Server=tcp:${azurerm_mssql_server.sql_server.fully_qualified_domain_name},1433;",
    "Initial Catalog=${azurerm_mssql_database.sql_database_orders.name};",
    "User ID=${var.sql_admin_username};",
    "Password=${random_password.sql_admin_password.result};",
    "Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;",
  ])
  key_vault_id = var.key_vault_id
}
