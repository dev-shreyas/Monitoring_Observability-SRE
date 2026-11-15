variable "project" {
  type    = string
  default = "ecommerce"
}

variable "environment" {
  type    = string
  default = "dev"
}

variable "vnet_address_space" {
  type    = string
  default = "10.10.0.0/16"
}

variable "subnet_address_prefix" {
  type    = string
  default = "10.10.1.0/24"
}

variable "pe_subnet_address_prefix" {
  type    = string
  default = "10.10.2.0/24"
}

variable "jumpbox_subnet_address_prefix" {
  type        = string
  default     = "10.10.3.0/24"
  description = "Subnet for the jumpbox VM. It sits in this VNet so it can resolve the private AKS API server FQDN, which only resolves via the VNet-linked private DNS zone."
}

variable "location" {
  type    = string
  default = "eastus"
}