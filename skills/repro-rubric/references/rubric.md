# Severity rubric (reference)

Mirrors `src/rubric.js`, which is the single source of truth for scoring.
If you change a factor here, change it there too.

## Factors (each 0–2)

### Exploitability — how easily can it be triggered?

| Score | Meaning | Evidence in the report |
|---|---|---|
| 2 | Unauthenticated, no user interaction | "unauthenticated", "without login", "no auth", "anonymous", "logged out" |
| 1 | Authenticated low-priv user, or needs a victim to click/visit | "logged in as…", "as a normal user", "victim clicks", "open the link" |
| 0 | Requires admin / high-privileged account | "admin account required", "requires admin" |

No auth signal at all → assume 1 (authenticated low-privileged user) and
flag the assumption in the triage summary.

### Impact — what breaks if it triggers?

Strongest matched impact class wins (weights 0–2):

| Weight | Classes |
|---|---|
| 2 | Remote code execution, authentication bypass, privilege escalation, sensitive data exfiltration, SQL injection, server-side request forgery |
| 1 | Broken access control / IDOR, cross-site scripting, cross-site request forgery, denial of service, security misconfiguration |
| 0 | Information disclosure (version strings, stack traces, verbose errors) |

No recognized impact class → impact 0, and the triage must say the report
does not state what breaks.

### Evidence — how complete is the reproduction evidence? (sets confidence)

One point each for: version pinned, 2+ numbered repro steps, PoC present
(curl, request/response, screenshot). Total capped at 2.
2 = High confidence, 1 = Medium, 0 = Low.

## Bands and escalation

Band = exploitability + impact: 4 Critical, 3 High, 2 Medium, 1 Low,
0 Informational.

Escalate only when band ≥ Medium AND confidence ≥ Medium. If confidence
is Low (band Low–Critical), return the missing-evidence checklist to the
reporter instead — a high-impact claim with no evidence is scored high but
never escalated, because it is unproven until the evidence arrives. Band
Informational, or band Low with Medium/High confidence, is low priority:
log it and move on.
