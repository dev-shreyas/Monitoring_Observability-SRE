variable "project" {
  type    = string
  default = "ecommerce"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "location" {
  type    = string
  default = "eastus"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group the private endpoints and DNS zones are created in (the networking module's RG, since it owns the PE subnet)"
}

variable "vnet_id" {
  type        = string
  description = "VNet ID (from the networking module) to link each private DNS zone to"
}

variable "pe_subnet_id" {
  type        = string
  description = "ID of the dedicated private-endpoints subnet (from the networking module)"
}

variable "sql_server_id" {
  type        = string
  description = "Resource ID of the Azure SQL logical server (from the sql module)"
}

variable "cosmosdb_account_id" {
  type        = string
  description = "Resource ID of the Cosmos DB account (from the cosmos module)"
}

variable "key_vault_id" {
  type        = string
  default     = ""
  description = "ID of the Key Vault to create a private endpoint for."
}

# Gated on a plain bool, NOT on `key_vault_id != ""`. On a build from zero the id is
# unknown until apply, and Terraform refuses a count it cannot evaluate at plan time:
#   The "count" value depends on resource attributes that cannot be determined until
#   apply, so Terraform cannot predict how many instances will be created.
# A variable is always known at plan time, so this works on an empty subscription too.
variable "key_vault_private_endpoint_enabled" {
  type        = bool
  default     = true
  description = "Create a Key Vault private endpoint. The linked DNS zone makes the whole VNet resolve the vault privately, so the endpoint must be healthy or secret mounts fail."
}

variable "storage_account_id" {
  type        = string
  default     = ""
  description = "ID of the storage account to create a blob private endpoint for."
}

variable "blob_private_endpoint_enabled" {
  type        = bool
  default     = true
  description = "Create a Blob private endpoint. Same plan-time reasoning as key_vault_private_endpoint_enabled."
}

variable "acr_id" {
  type        = string
  default     = ""
  description = "ID of the container registry. Only used when acr_private_endpoint_enabled is true."
}

variable "acr_private_endpoint_enabled" {
  type        = bool
  default     = false
  description = "ACR private endpoints require the Premium SKU (~5x Standard's cost). Leave false on a Standard registry -- enabling it there fails the apply."
}
