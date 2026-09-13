
## SSO/SAML/SCIM Platform Identity (Zitadel Cloud) - 2026-07-23
- [ ] Which Zitadel claim carries multi-tenant org scope, and how does it map to each app's orgId? — blocks correct authorization for chorus/helmsman/warden
- [ ] Is Zitadel Cloud's SCIM v2 service-provider support mature enough for the target customer IdPs (Okta/Entra), or is management-API provisioning the fallback? — determines whether SCIM deliverable is achievable as designed
- [ ] Do any apps use Supabase RLS keyed on auth.uid() (vs app-layer RBAC only)? — those policies break when sub changes from Supabase UUID to Zitadel subject
- [ ] One Zitadel OIDC client per app (5 audiences) vs a shared client — which token-audience model do the 5 middlewares tolerate? — affects Zitadel setup and per-app verification config
