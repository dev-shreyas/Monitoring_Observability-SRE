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
  type = string
}

variable "subnet_id" {
  type        = string
  description = "ID of the subnet (from the networking module) to deploy AKS nodes into"
}

variable "log_analytics" {
  type        = string
  description = "ID of the Log Analytics workspace for the oms_agent (Container Insights) integration"
}

variable "acr_id" {
  type        = string
  description = "ID of the Azure Container Registry to grant AKS access to"
}

variable "api_server_authorized_ip_ranges" {
  type        = list(string)
  default     = []
  description = "CIDRs allowed to reach the public API server endpoint. Empty (the default) leaves it open to the whole internet. Lock it down with your egress IP: curl -4 -s ifconfig.me"
}

variable "cluster_admin_object_ids" {
  type        = list(string)
  default     = []
  description = "Azure AD object IDs (users or groups) to grant cluster-admin on this cluster. Because azure_rbac_enabled = true, access is granted via Azure role assignments rather than --aad-admin-group-object-ids. Find yours with: az ad signed-in-user show --query id -o tsv"
}
