output "namespace_id" {
  value = azurerm_servicebus_namespace.main.id
}

output "namespace_name" {
  value = azurerm_servicebus_namespace.main.name
}

output "topic_id" {
  value = azurerm_servicebus_topic.order_events.id
}
