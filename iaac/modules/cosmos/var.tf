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
variable "key_vault_id" {
  type        = string
  description = "ID of the Key Vault (from the keyvault module) to store the Cosmos connection string in"
}
