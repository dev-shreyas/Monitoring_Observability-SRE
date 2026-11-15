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
  description = "ID of the Key Vault (from the keyvault module) to store the App Insights connection string in"
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Address that receives metric alerts. Empty (the default) creates no action group and no alerts -- set it to turn alerting on. This address is sent to Azure Monitor and will receive mail."
}
