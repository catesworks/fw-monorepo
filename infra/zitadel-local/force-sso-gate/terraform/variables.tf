variable "zitadel_domain" {
  type        = string
  description = "Zitadel API domain, e.g. idp.example.com (localhost for the throwaway stack)."
}

variable "zitadel_port" {
  type    = string
  default = "443"
}

variable "zitadel_insecure" {
  type        = bool
  default     = false
  description = "http instead of https. Only for a local throwaway stack."
}

variable "target_name" {
  type    = string
  default = "force-sso-gate"
}

variable "gate_endpoint" {
  type        = string
  description = "Public HTTPS URL of the gate, ending in /force-sso. Zitadel's production denylist rejects private/localhost targets."
  validation {
    condition     = can(regex("^https://", var.gate_endpoint)) || can(regex("^http://(localhost|host\\.docker\\.internal)[:/]", var.gate_endpoint))
    error_message = "gate_endpoint must be https:// (http only for localhost / host.docker.internal on a throwaway stack)."
  }
}

variable "timeout" {
  type        = string
  default     = "5s"
  description = "Per-call target timeout. Must exceed the gate's own lookup timeout (3s) so a slow lookup is answered by the gate's fail mode, not cut off by Zitadel."
}

variable "interrupt_on_error" {
  type        = bool
  default     = true
  description = "true = a non-2xx/unreachable gate blocks the call (enforce, fail closed from Zitadel's side). false = shadow stage: target failures are ignored. Run the gate with GATE_MODE=shadow while this is false."
}
