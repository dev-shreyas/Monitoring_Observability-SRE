output "aks_subnet_id" {
  value = azurerm_subnet.aks_subnet.id
}

output "vnet_id" {
  value = azurerm_virtual_network.vnet.id
}

output "pe_subnet_id" {
  value = azurerm_subnet.aks_private_endpoints.id
}

output "jumpbox_subnet_id" {
  value = azurerm_subnet.jumpbox.id
}

output "resource_group_name" {
  value = azurerm_resource_group.network.name
}
