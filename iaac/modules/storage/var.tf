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

variable "account_replication_type" {
  type        = string
  default     = "LRS"
  description = "LRS for dev (cheapest, single datacenter). Use ZRS or GRS for staging/prod -- LRS loses data if the datacenter does."
}

variable "public_network_access_enabled" {
  type        = bool
  default     = true
  description = "Keep true while Terraform runs from outside the VNet: creating containers is a data-plane operation. Set false once a Blob private endpoint exists and Terraform runs inside the VNet."
}

variable "blob_contributor_principal_ids" {
  type        = list(string)
  default     = []
  description = "Principal IDs (workload identities) granted Storage Blob Data Contributor, so services read/write images without a storage account key."
}
