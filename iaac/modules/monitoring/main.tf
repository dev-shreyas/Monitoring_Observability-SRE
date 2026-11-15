resource "azurerm_resource_group" "monitoring" {
  name     = "rg-${var.project}-monitoring-${var.environment}"
  location = var.location
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "law-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = azurerm_resource_group.monitoring.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# Application Insights: APM and distributed tracing for the Node services (guide
# section 21). Workspace-based rather than classic -- classic App Insights is retired,
# and linking it to the Log Analytics workspace above means app traces and container
# logs are queryable together in one place.
resource "azurerm_application_insights" "main" {
  name                = "appi-${var.project}-${var.environment}"
  location            = var.location
  resource_group_name = azurerm_resource_group.monitoring.name
  application_type    = "Node.JS"
  workspace_id        = azurerm_log_analytics_workspace.main.id
}

# The connection string the services read as APPINSIGHTS_CONNECTION_STRING. Stored in
# Key Vault rather than passed as a plain env var because it contains an ingestion key.
resource "azurerm_key_vault_secret" "appinsights_connection_string" {
  name         = "appinsights-connection-string"
  value        = azurerm_application_insights.main.connection_string
  key_vault_id = var.key_vault_id
}

# Alerting is created only when an address is supplied. An action group with no receiver
# is an alert that fires into the void, which is worse than no alert at all -- it looks
# like coverage on a dashboard while notifying nobody.
resource "azurerm_monitor_action_group" "oncall" {
  count = var.alert_email == "" ? 0 : 1

  name                = "ag-${var.project}-oncall-${var.environment}"
  resource_group_name = azurerm_resource_group.monitoring.name
  short_name          = "oncall" # max 12 chars, shown as the SMS/email sender

  email_receiver {
    name          = "oncall-email"
    email_address = var.alert_email
  }
}

resource "azurerm_monitor_metric_alert" "high_error_rate" {
  count = var.alert_email == "" ? 0 : 1

  name                = "alert-${var.project}-5xx-${var.environment}"
  resource_group_name = azurerm_resource_group.monitoring.name
  scopes              = [azurerm_application_insights.main.id]
  description         = "Request failure count exceeded the threshold"
  severity            = 1
  window_size         = "PT5M"
  frequency           = "PT1M"

  criteria {
    metric_namespace = "Microsoft.Insights/components"
    metric_name      = "requests/failed"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 10
  }

  action {
    action_group_id = azurerm_monitor_action_group.oncall[0].id
  }
}
