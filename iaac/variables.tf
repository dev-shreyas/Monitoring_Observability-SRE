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

variable "kubernetes_version" {
  type    = string
  default = "1.29"
}

variable "aks_cluster_admin_object_ids" {
  type        = list(string)
  default     = []
  description = "Azure AD object IDs granted cluster-admin on AKS. Get yours with: az ad signed-in-user show --query id -o tsv"
}

variable "aks_api_server_authorized_ip_ranges" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the public AKS API server. Empty (the default) leaves the endpoint open to the whole internet, protected only by Azure AD auth. Get your egress IP with: curl -4 -s ifconfig.me"
}

variable "keyvault_secrets_admin_object_ids" {
  type        = list(string)
  default     = []
  description = "Azure AD object IDs of people who need to read/write Key Vault secrets in the portal. Get yours with: az ad signed-in-user show --query id -o tsv"
}

variable "aad_admin_object_id" {
  type        = string
  default     = "2657ea4b-3acd-4570-9385-99b8cde16735"
  description = "Object ID of the Azure AD user or group to set as the SQL Server's AAD admin. Get yours with: az ad signed-in-user show --query id -o tsv"
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Address that receives Azure Monitor metric alerts. Empty (the default) creates no action group and no alert rules. Setting it means this address is registered with Azure Monitor and will receive mail."
}

variable "storage_blob_contributor_principal_ids" {
  type        = list(string)
  default     = []
  description = "Principal IDs granted Storage Blob Data Contributor on the images account — typically the product-service workload identity, so it reads/writes blobs without a storage key."
}

variable "acr_private_endpoint_enabled" {
  type        = bool
  default     = false
  description = "ACR private endpoints require the Premium SKU (~5x Standard). Leave false on a Standard registry: enabling it there fails the apply."
}
