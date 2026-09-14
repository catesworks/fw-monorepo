<!--
PUBLIC blog post draft. ⚠ SANITIZE before publishing:
  - Remove client names, internal repo/package names, hostnames, ticket ids, secrets.
  - Generalize the setting ("a multi-tenant SaaS", "an internal infra monorepo").
  - When in doubt, leave it out. Ask the user before publishing anywhere.
Keep it a story about the PROBLEM and the TECHNIQUE, not the proprietary system.
-->

# Your "before" state might not be what your migration plan thinks it is

_Two independent AI code-review passes caught two completely different, real bugs in the same identity-migration plan — and neither would have been caught by just reading the plan carefully myself._

## The problem

Migrating a multi-app suite from one identity provider to a central one is the
kind of project where the plan document says "5 apps, 5 separate auth
systems, no SSO today" — and that sentence is simply wrong, because someone
already wired up a partial SSO integration eight months ago through a side
door nobody wrote back into the master plan.

That's what happened here. A plan to move a suite of internal apps onto a
central identity provider assumed a clean starting point: every app verifies
its own provider's tokens directly, no shared login exists. Digging into one
app's actual login code turned up a comment that flatly contradicted the
plan's own "grounded facts" section: production login for that app _already_
federated through the target identity provider — just indirectly, through the
old provider acting as a relay. The token users actually got was still
minted by the old system. Nothing in the new plan accounted for that.

## What I tried

Two things caught real problems here, and neither was "read the code more
carefully":

**First**, an adversarial critic pass on a design decision — before any code
was written — caught that the decision conflated two different values. The
plan said "use this external ID to link accounts." What it should have said
was "use this external ID to _find_ the right account, then store a
_completely different_ ID once you've found it." Small distinction, but get
it backwards and the very first real login after migration silently fails to
match, forever.

```ts
// Wrong: the lookup key and the stored value are not the same thing
user.correlationId = externalId;

// Right: externalId only ever locates the row; a different value gets stored
const localUser = await findByExternalId(externalId);
localUser.providerSubject = tokenPayload.sub; // NOT externalId
```

The same review also caught a cardinality bug: the plan assumed one external
identifier field could hold a value unique to _each_ of four downstream
systems simultaneously. It can't — one field, one value. That's not a bug you
spot by re-reading your own plan; it took an independent pass explicitly
looking for exactly this kind of assumption.

**Second**, a later critic pass on the actual implementation plan (after
requirements had legitimately simplified — turned out there were only a
couple of real users to migrate, so a full zero-downtime dual-write migration
was overkill) caught three more things, all concrete: the new provider's
tokens weren't even in the format the verification code expected by default
(an easy one-line config fix, but a hard blocker until found); a proposed
security hardening (HttpOnly cookies) silently broke existing browser code
that needed to read the token directly; and a test-environment bypass
assumed two configuration paths could coexist in the same running process
when the actual code took one exclusively.

## What I learned

- **A plan's "grounded facts" section is a claim, not a given** — verify it
  against actual running behavior, especially for anything with "already,"
  "currently," or "today" in it. Two-week-old internal documentation
  contradicted the plan's assumption before any code review even happened.
- **Correctness reviews for security-adjacent design decisions are worth
  running twice** — once on the decision itself, before code, and again on
  the concrete implementation plan, after code. They catch different classes
  of bug. The first pass never would have caught the opaque-token default;
  the second pass never would have caught the cardinality assumption.
- **"Store X" and "look up by X" are different operations even when X is the
  same field name.** This is an easy category of bug to write and a hard one
  to notice yourself, because both operations _feel_ like "using the
  identifier."
- **Simplifying scope (fewer real users → skip the elaborate migration
  machinery) is a legitimate call, but it doesn't reduce how carefully the
  _smaller_ remaining plan needs reviewing.** The simplified plan still had 5
  real, blocking issues.

## Takeaways

- Before trusting a migration plan's premise, check it against what's
  actually running — not what the plan says is running.
- Run an adversarial review pass on identity/auth-adjacent decisions before
  writing code, and again on the concrete plan before executing it — they
  catch different bugs.
- Watch specifically for "the same identifier used two ways" — as a lookup
  key vs. as a stored value — it's an easy, quiet place for a real bug to
  hide.
- A smaller scope isn't a safer scope by default. Review it like you would
  the bigger version.

---

<!-- Suggested tags: identity migration, code review, SSO, AI-assisted development · Est. reading time: 5 min · Cross-post targets: personal blog, dev.to -->
