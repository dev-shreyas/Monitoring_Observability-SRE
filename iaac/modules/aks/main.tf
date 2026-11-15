data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "aks" {
  name     = "rg-${var.project}-aks-${var.environment}"
  location = var.location
}

resource "azurerm_user_assigned_identity" "aks_identity" {
  name                = "uai-aks-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = azurerm_resource_group.aks.name

}

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "aks-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = azurerm_resource_group.aks.name
  dns_prefix          = "aks-${var.project}-${var.environment}"
  kubernetes_version  = var.kubernetes_version

  # Public API server. The private cluster's FQDN resolved only inside the VNet, which
  # meant kubectl needed a jumpbox VM in that VNet — 2 vCPU of a 4 vCPU regional quota
  # spent purely on reaching the cluster. Public access removes that cost and lets
  # kubectl (and hosted CI agents) connect from anywhere.
  #
  # The trade-off is real: the API server is now on the internet, defended only by Azure
  # AD auth plus the RBAC roles below. Narrow it with api_server_authorized_ip_ranges
  # (see below) — that is the one control that puts a network boundary back.
  #
  # NOTE: this flag is immutable. Flipping it destroys and recreates the whole cluster.
  private_cluster_enabled = false

  # Restricts which source IPs may even reach the API server endpoint. Left empty the
  # endpoint is open to the entire internet; populate it and everything else is refused
  # at the network layer before authentication is attempted.
  #
  # The block is emitted only when the list is non-empty, because an empty
  # authorized_ip_ranges on an existing cluster is how you'd *remove* a restriction and
  # Terraform would otherwise churn on it every plan.
  dynamic "api_server_access_profile" {
    for_each = length(var.api_server_authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.api_server_authorized_ip_ranges
    }
  }

  default_node_pool {
    name                         = "default"
    node_count                   = 1
    vm_size                      = "Standard_D2s_v7"
    vnet_subnet_id               = var.subnet_id
    zones                        = []
    orchestrator_version         = var.kubernetes_version
    only_critical_addons_enabled = true
    # Capped at 1 node: the subscription's Total Regional vCPU quota is 4, and this
    # pool (2 vCPU) plus userpool (2 vCPU) already consumes all of it. Raise these
    # once the quota increase lands.
    auto_scaling_enabled = true
    min_count            = 1
    max_count            = 1
    # Required whenever vm_size (or a handful of other immutable-in-place properties)
    # changes on an existing default node pool: Azure can't resize it directly, so the
    # provider spins up a pool under this temporary name, migrates over, then recreates
    # "default" with the new settings. Must be lowercase alphanumeric, <=12 characters.
    //temporary_name_for_rotation = "tmpdefault"
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks_identity.id]
  }

  node_provisioning_profile {
    mode = "Manual"
  }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # Secrets Store CSI driver — mounts Key Vault secrets into pods as files, driven by a
  # SecretProviderClass (see k8s/base/secret-provider-class.yaml). Pairs with the
  # Workload Identity setup in modules/keyvault: the identity says who the pod is, this
  # is the mechanism that actually delivers the secret to it.
  #
  # The CLI equivalent is
  #   az aks enable-addons -g <rg> -n <cluster> --addons azure-keyvault-secrets-provider
  # but do NOT use it. This block is how the provider models the addon, so with the
  # block absent Terraform reads a CLI-enabled addon as drift and plans to disable it
  # again on the next unrelated apply.
  key_vault_secrets_provider {
    # Re-reads the vault on an interval and updates the mounted files, so a rotated
    # secret reaches pods without a redeploy. Off by default, in which case the mounted
    # value is frozen at pod start.
    secret_rotation_enabled  = true
    secret_rotation_interval = "2m"
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "azure"
    load_balancer_sku = "standard"
    # "userDefinedRouting" needs a route table already associated with the AKS subnet
    # (for routing egress through a hub firewall) — this repo doesn't have a hub/firewall
    # yet, so there's no route table to associate. "loadBalancer" needs nothing extra:
    # AKS's own standard load balancer handles outbound SNAT.
    outbound_type = "loadBalancer"
  }

  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
    tenant_id          = data.azurerm_client_config.current.tenant_id
  }

  oms_agent {
    log_analytics_workspace_id = var.log_analytics
  }

  azure_policy_enabled = true

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "user_pool" {
  name                  = "userpool"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id
  # Back to 1 node now that the jumpbox is gone. The regional quota is 4 vCPU total:
  # the system pool takes 2, and these 2 used to be surrendered to the jumpbox, leaving
  # nowhere to run application pods (the system pool is tainted CriticalAddonsOnly).
  # Dropping the VM returns them here, so the cluster can actually host the app again.
  #
  # Still capped at one D2s_v7. Raise node_count, and move to D4s_v7, once the quota
  # increase is approved.
  #
  # Autoscaling is OFF deliberately. With it on, the cluster autoscaler owns the node
  # count and Terraform's node_count is ignored — which made this pool impossible to
  # shrink on demand back when the quota had to be juggled with the jumpbox. Turn it
  # back on together with the quota increase.
  vm_size              = "Standard_D2s_v7"
  node_count           = 1
  vnet_subnet_id       = var.subnet_id
  orchestrator_version = var.kubernetes_version
  mode                 = "User"
  auto_scaling_enabled = false
  node_labels = {
    "workload" = "app"
  }
}

# Spot pool disabled until the vCPU quota increase lands.
#
# There's a separate "Total Regional Low-priority vCPUs" quota (limit 3) that spot
# nodes draw from, so spot looks affordable at first glance — but spot nodes ALSO
# count against the per-family quota, and "Standard Dsv7 Family vCPUs" (limit 4) is
# fully consumed by the system pool (2) plus userpool (2). So there's no room for a
# Dsv7 spot node on top of those.
#
# Uncomment this once the quota increase is approved.
#
# resource "azurerm_kubernetes_cluster_node_pool" "spot_pool" {
#   name                  = "spotpool"
#   kubernetes_cluster_id = azurerm_kubernetes_cluster.aks.id
#   vm_size               = "Standard_D4s_v7"
#   node_count            = 1
#   vnet_subnet_id        = var.subnet_id
#   orchestrator_version  = var.kubernetes_version
#   mode                  = "User"
#   priority              = "Spot"
#   eviction_policy       = "Delete"
#   spot_max_price        = -1
#   auto_scaling_enabled  = true
#   min_count             = 0
#   max_count             = 2
#   node_labels = {
#     "workload" = "batch"
#   }
#   node_taints = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]
# }

resource "azurerm_role_assignment" "aks_identity_role" {
  scope                = var.acr_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.aks.kubelet_identity[0].object_id
}

# Required because this cluster uses a bring-your-own VNet that lives in a DIFFERENT
# resource group (rg-<project>-network-<env>) from the cluster.
#
# AKS automatically grants its identity Contributor over the node resource group it
# creates for itself (MC_*), and that covers most day-to-day operations — which is why
# the cluster came up fine without this. It does NOT cover a subnet the cluster did not
# create. The first operation that actually needs it is provisioning a LoadBalancer
# Service: to allocate a frontend IP, AKS must read the subnet, and fails with
#
#   AuthorizationFailed: ... does not have authorization to perform action
#   'Microsoft.Network/virtualNetworks/subnets/read' over scope '.../subnets/...'
#
# leaving the Service stuck at EXTERNAL-IP <pending> indefinitely. The error surfaces in
# `kubectl get events`, not in anything Terraform reports, so it looks like a Kubernetes
# problem rather than a missing Azure role.
#
# Scoped to the subnet rather than the whole VNet: it is the narrowest scope that works,
# and it keeps the cluster from being able to alter unrelated subnets (private endpoints,
# for instance) in the same VNet.
resource "azurerm_role_assignment" "aks_subnet_network_contributor" {
  scope                = var.subnet_id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_user_assigned_identity.aks_identity.principal_id
}

# Human cluster access. With azure_rbac_enabled = true, Kubernetes authorization runs
# through Azure role assignments, so these two roles are what grant kubectl access —
# not `az aks update --aad-admin-group-object-ids`, which belongs to the other mode
# (AAD integration backed by Kubernetes RBAC). Subscription Owner does NOT imply either.
#
#   Cluster User Role      -> allowed to run `az aks get-credentials`
#   RBAC Cluster Admin     -> allowed to actually do things once connected
resource "azurerm_role_assignment" "cluster_user" {
  for_each = toset(var.cluster_admin_object_ids)

  scope                = azurerm_kubernetes_cluster.aks.id
  role_definition_name = "Azure Kubernetes Service Cluster User Role"
  principal_id         = each.value
}

resource "azurerm_role_assignment" "cluster_rbac_admin" {
  for_each = toset(var.cluster_admin_object_ids)

  scope                = azurerm_kubernetes_cluster.aks.id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = each.value
}