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

variable "sql_admin_username" {
  type    = string
  default = "sql-admin"
}

variable "aad_admin_login_username" {
  type        = string
  default     = "sql-admins"
  description = "Display name shown for the Azure AD admin on the SQL server (the AAD group/user itself is identified by aad_admin_object_id)"
}

variable "aad_admin_object_id" {
  type        = string
  default     = "2657ea4b-3acd-4570-9385-99b8cde16735"
  description = "Object ID of the Azure AD user or group to set as the SQL Server's AAD admin. Get yours with: az ad signed-in-user show --query id -o tsv"
}

variable "key_vault_id" {
  type        = string
  description = "ID of the Key Vault (from the keyvault module) to store the generated SQL admin password in"
}