output "storage_account_id" {
  value = azurerm_storage_account.main.id
}

output "storage_account_name" {
  value = azurerm_storage_account.main.name
}

output "primary_blob_endpoint" {
  value       = azurerm_storage_account.main.primary_blob_endpoint
  description = "Base URL for blob access, e.g. the CDN/Front Door origin."
}

output "product_images_container" {
  value = azurerm_storage_container.product_images.name
}
