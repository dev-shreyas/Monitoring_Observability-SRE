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

variable "public_network_access_enabled" {
  type        = bool
  default     = true
  description = "Keep true while Terraform runs from outside the VNet — it needs data-plane access to write secrets. Set false once a Key Vault private endpoint exists and Terraform runs from inside the VNet."
}

variable "allowed_ip_rules" {
  type        = list(string)
  default     = []
  description = "Public IPs/CIDRs allowed to reach the vault's data plane. Empty means allow all (dev default); populating it switches the vault to deny-by-default and permits only these."
}

variable "aks_oidc_issuer_url" {
  type        = string
  description = "OIDC issuer URL of the AKS cluster, from module.aks.oidc_issuer_url. Azure AD uses it to verify the projected service account token a pod presents, so it must be the cluster's real issuer — a hardcoded sts.windows.net URL will not work. Requires oidc_issuer_enabled = true on the cluster."
}

variable "workload_namespace" {
  type        = string
  default     = ""
  description = "Kubernetes namespace of the pods that read secrets. Defaults to ecommerce-<environment> when empty, matching k8s/base/."
}

variable "workload_identities" {
  type = map(string)
  default = {
    order-service   = "order-service-sa"
    product-service = "product-service-sa"
    user-service    = "user-service-sa"
  }
  description = <<-EOT
    One Azure identity per microservice: map of service name -> Kubernetes ServiceAccount name.

    Deliberately one identity each rather than a single shared one. Sharing would work and is
    less code, but every service would then hold the same Key Vault access, so compromising
    any one pod would expose all services' secrets. Separate identities keep that blast
    radius to a single service and let the grants diverge later (product-service does not
    need the SQL secrets, for instance).

    Each ServiceAccount name must match the Kubernetes object EXACTLY — the federated
    credential subject is built from it, and a mismatch fails at runtime with AADSTS70021
    (no matching federated identity record), which nothing catches at plan time.
  EOT
}

variable "secrets_admin_object_ids" {
  type        = list(string)
  default     = []
  description = "Azure AD object IDs of humans who should be able to read/write secrets in the portal. Subscription Owner alone does NOT grant data-plane access on an RBAC-enabled vault — it needs an explicit role like this. Find yours with: az ad signed-in-user show --query id -o tsv"
}
