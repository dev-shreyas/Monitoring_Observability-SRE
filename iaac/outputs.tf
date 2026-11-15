# The API server is public, so this works from anywhere — no jumpbox, no VPN.
#
# kubelogin is still required despite the public endpoint: the cluster runs with
# azure_rbac_enabled = true, so the kubeconfig authenticates through an exec credential
# plugin. Without it kubectl fails with "executable kubelogin not found". Install it with
#   az aks install-cli
# which installs both kubectl and kubelogin.
output "aks_get_credentials_command" {
  value       = "az aks get-credentials --resource-group ${module.aks.resource_group_name} --name ${module.aks.cluster_name} --overwrite-existing"
  description = "Fetches the kubeconfig for the cluster. Run `az aks install-cli` first if kubelogin is missing."
}

output "aks_cluster_name" {
  value       = module.aks.cluster_name
  description = "Name of the AKS cluster."
}

# One client ID per service. Put each on the matching ServiceAccount:
#   azure.workload.identity/client-id: <the value for that service>
# and label the pod template azure.workload.identity/use: "true".
#
# Read a single one with:
#   terraform output -json workload_identity_client_ids | jq -r '."user-service"'
output "workload_identity_client_ids" {
  value       = module.keyvault.workload_identity_client_ids
  description = "Service name -> client ID for annotating each Kubernetes ServiceAccount. NOT interchangeable between services: using another service's id fails token exchange at runtime."
}
