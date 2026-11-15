terraform {
  required_version = ">= 1.7.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "=5.4.0"
    }

    random = {
      source  = "hashicorp/random"
      version = "=3.9.0"
    }

    # Used in modules/keyvault to pause for Azure RBAC propagation before any data-plane
    # secret write is attempted. See the comment on time_sleep.wait_for_rbac.
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }

    # Cosmos DB account deletion is asynchronous on Azure's backend and can still be
    # finishing up after the API call that requested it returns success. Without this,
    # a resource group destroy that races ahead of that cleanup fails with "the Resource
    # Group still contains Resources" even though nothing is actually left behind.
    resource_group {
      prevent_deletion_if_contains_resources = false
    }
  }
}