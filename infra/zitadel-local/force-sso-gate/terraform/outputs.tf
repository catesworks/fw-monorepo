# The gate verifies ZITADEL-Signature with this key. It also lands in terraform state:
# use an encrypted remote backend, and deliver the key to the gate from a secret store
# (GATE_SIGNING_KEY_FILE), never into git or logs.
output "signing_key" {
  value     = zitadel_action_target.force_sso_gate.signing_key
  sensitive = true
}

output "target_id" {
  value = zitadel_action_target.force_sso_gate.id
}
