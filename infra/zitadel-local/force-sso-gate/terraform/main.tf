# Force-SSO gate: Zitadel Actions V2 target + executions (fw-uwku).
# PLAN-ABLE, NEVER APPLIED from this repo: apply is a needs-user production step,
# see ../../force-sso-gate-ops.md (rollout runbook). The gate service is gate.mjs.
#
# Executions are method-level on purpose. A service-level `service` condition on
# SessionService would also fire on the gate's own GetSession lookups (findings, (3)).
terraform {
  required_version = ">= 1.5"
  required_providers {
    zitadel = {
      source = "zitadel/zitadel"
    }
  }
}

# Credentials come from the environment/provider variables at plan time, never from
# files in this repo: ZITADEL_ACCESS_TOKEN or a JWT profile file, e.g.
#   export ZITADEL_ACCESS_TOKEN=$(<read from your secret store>)
provider "zitadel" {
  domain   = var.zitadel_domain
  insecure = var.zitadel_insecure
  port     = var.zitadel_port
}

resource "zitadel_action_target" "force_sso_gate" {
  name               = var.target_name
  endpoint           = var.gate_endpoint
  target_type        = "REST_WEBHOOK"
  timeout            = var.timeout
  interrupt_on_error = var.interrupt_on_error
  payload_type       = "PAYLOAD_TYPE_JSON"
}

locals {
  # session gate + finalize gate; v2 AND v2beta (v2beta alone would be a bypass)
  gated_methods = toset([
    "/zitadel.session.v2.SessionService/CreateSession",
    "/zitadel.session.v2.SessionService/SetSession",
    "/zitadel.session.v2beta.SessionService/CreateSession",
    "/zitadel.session.v2beta.SessionService/SetSession",
    "/zitadel.oidc.v2.OIDCService/CreateCallback",
    "/zitadel.oidc.v2beta.OIDCService/CreateCallback",
    "/zitadel.oidc.v2.OIDCService/AuthorizeOrDenyDeviceAuthorization",
    "/zitadel.saml.v2.SAMLService/CreateResponse",
  ])
}

resource "zitadel_action_execution_request" "gate" {
  for_each   = local.gated_methods
  method     = each.value
  target_ids = [zitadel_action_target.force_sso_gate.id]
}
