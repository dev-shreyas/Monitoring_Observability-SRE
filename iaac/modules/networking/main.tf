resource "azurerm_resource_group" "network" {
  name     = "rg-${var.project}-network-${var.environment}"
  location = var.location
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-${var.project}-${var.environment}"
  address_space       = [var.vnet_address_space]
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name
}

resource "azurerm_subnet" "aks_subnet" {
  name                 = "subnet-${var.project}-${var.environment}"
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.subnet_address_prefix]
}

resource "azurerm_subnet" "aks_private_endpoints" {
  name                 = "subnet-${var.project}-${var.environment}-private-endpoints"
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.pe_subnet_address_prefix]

  private_endpoint_network_policies = "Disabled"
}

resource "azurerm_subnet" "jumpbox" {
  name                 = "subnet-${var.project}-${var.environment}-jumpbox"
  resource_group_name  = azurerm_resource_group.network.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [var.jumpbox_subnet_address_prefix]
}

resource "azurerm_network_security_group" "aks_nsg" {
  name                = "nsg-${var.project}-${var.environment}"
  location            = azurerm_resource_group.network.location
  resource_group_name = azurerm_resource_group.network.name

  security_rule {
    name                       = "Allow-HTTPS-Inbound"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "443"
    source_address_prefix      = "AzureFrontDoor.Backend"
    destination_address_prefix = "*"
  }

  # Restores the intra-VNet traffic that Deny-All-Inbound below would otherwise block.
  #
  # Azure already ships an AllowVnetInBound default rule, but it sits at priority 65000
  # and NSG rules are evaluated lowest-number-first — so the custom deny at 4096 beats
  # it and drops VNet-internal traffic that Azure expects to be allowed.
  #
  # What breaks without this: the AKS control plane reaches each node's kubelet on port
  # 10250 through the konnectivity agents, and those agents run on one node while the
  # kubelet they must reach may be on another. Blocking node-to-node 10250 makes
  # `kubectl exec`, `kubectl logs`, `kubectl port-forward` and `kubectl top` all fail
  # with a 504 from the proxy, while the cluster otherwise looks completely healthy —
  # pods run, probes pass, nothing reports an error.
  #
  # This is scoped to VirtualNetwork as source AND destination, so it re-permits internal
  # traffic only. Everything arriving from the internet still falls through to the deny.
  security_rule {
    name                       = "Allow-VNet-Inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "VirtualNetwork"
  }

  # Azure's load balancer health probes. Like AllowVnetInBound, Azure ships an
  # AllowAzureLoadBalancerInBound default — but at priority 65001, so the custom deny at
  # 4096 beats it. With probes blocked the load balancer marks every node unhealthy and
  # drops traffic before it reaches the cluster, which looks identical to a missing
  # allow rule: a public IP that simply times out.
  security_rule {
    name                       = "Allow-AzureLoadBalancer-Inbound"
    priority                   = 3900
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "AzureLoadBalancer"
    destination_address_prefix = "*"
  }

  # Public HTTP to the ingress controller, which routes to the frontend.
  #
  # This is what actually puts the application on the internet. Deliberate, but be clear
  # about what it means:
  #   - port 80 only, so traffic is UNENCRYPTED end to end; anything typed into a login
  #     form crosses the network in plaintext. Add TLS (cert-manager or a Key Vault cert)
  #     and switch the ingress to ssl-redirect before this carries real credentials.
  #   - the frontend proxies /login, /cart, /orders ... straight through to the backends,
  #     so those APIs are reachable by anyone with the IP.
  #
  # Narrow source_address_prefix from "Internet" to a specific CIDR to restrict who can
  # reach it, or delete this rule to take the app back off the internet entirely.
  security_rule {
    name                       = "Allow-HTTP-Inbound"
    priority                   = 3950
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "80"
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }

  # Catch-all. Note it only covers Tcp — Udp and Icmp from the internet still fall
  # through to Azure's DenyAllInBound default at 65500, which is the real backstop.
  security_rule {
    name                       = "Deny-All-Inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks_subnet_nsg_assoc" {
  subnet_id                 = azurerm_subnet.aks_subnet.id
  network_security_group_id = azurerm_network_security_group.aks_nsg.id
}
