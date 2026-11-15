# Decouples order-service from downstream consumers (inventory, notifications,
# analytics) via pub/sub, instead of order-service calling each of them directly.

resource "azurerm_resource_group" "servicebus" {
  name     = "rg-${var.project}-servicebus-${var.environment}"
  location = var.location
}

resource "azurerm_servicebus_namespace" "main" {
  name                = "sb-${var.project}-${var.environment}-${random_string.sb_key.result}"
  location            = var.location
  resource_group_name = azurerm_resource_group.servicebus.name
  sku                 = var.sku
}

resource "random_string" "sb_key" {
  length  = 5
  special = false
  upper   = false
  lower   = true
}

resource "azurerm_servicebus_topic" "order_events" {
  name         = "order-events"
  namespace_id = azurerm_servicebus_namespace.main.id
}

# One subscription per downstream consumer — each gets every message published to
# the topic, independent of the others (that's what makes this pub/sub rather than
# a queue, where competing consumers would split the messages between them).
resource "azurerm_servicebus_subscription" "consumers" {
  for_each = toset(var.subscriptions)

  name               = each.value
  topic_id           = azurerm_servicebus_topic.order_events.id
  max_delivery_count = 10
}

# Nothing in code/config should hold this connection string directly — services
# read it from Key Vault via the CSI driver, same as the SQL admin password.
resource "azurerm_key_vault_secret" "servicebus_connection_string" {
  name         = "servicebus-connection-string"
  value        = azurerm_servicebus_namespace.main.default_primary_connection_string
  key_vault_id = var.key_vault_id
}
