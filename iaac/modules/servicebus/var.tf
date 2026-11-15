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

variable "sku" {
  type        = string
  default     = "Standard"
  description = "Standard or Premium — Topics (pub/sub) aren't supported on the Basic tier"
}

variable "key_vault_id" {
  type        = string
  description = "ID of the Key Vault (from the keyvault module) to store the namespace connection string in"
}

variable "subscriptions" {
  type        = list(string)
  default     = ["inventory", "notifications", "analytics"]
  description = "One subscription per downstream consumer of order events (see architecture doc, section 2)"
}
