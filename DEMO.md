# Repro — demo script (for the < 5 min video + judge testing)

Target: show the before/after contrast inside the first 3 minutes.
The demo data below is also the seed data for the trial site.

## Seed data (create on the trial site before recording)

**Known issues** (so dedup has something to hit):

| Key | Summary | Component | Why it exists |
|---|---|---|---|
| SEC-88 | Avatar upload SSRF to internal metadata endpoint | upload | Dedup target for report B |
| SEC-101 | Login bypass on 4.2.1 allows access without password | login | Dedup distractor for report A |
| SEC-77 | Checkout page shows wrong currency symbol | checkout | Noise / non-security control |

**Owning teams** (component table in `src/rubric.js`): login → Identity,
checkout → Payments, admin/api → Platform, search → Search,
upload → Media, user → Identity. Edit the table to match the demo site.

## The two reports (paste into Rovo Chat, or open as JSM requests)

### Report A — vague (0:30–2:00)

> URGENT!!! Login is broken, CRITICAL vulnerability. Anyone can get in.
> Please fix ASAP. Reported by a customer.

Expected agent output: **Low band, Low confidence, NEEDS_MORE_EVIDENCE**.
Missing checklist: affected version, numbered repro steps, PoC,
demonstrated impact, expected vs actual, environment. No duplicate hit.
Routing: no component identified → ask the reporter for it (the word
"login" does map to the Identity team via the component table if the
agent parses it — either answer is honest as long as it says why).

### Report B — same bug class, with a working repro (2:00–3:30)

> Title: SSRF in avatar upload reaches internal metadata endpoint
>
> Affected version: 4.2.1
> Component: upload / avatar
>
> Steps to reproduce:
> 1. Log in as a normal user and open the avatar upload at /api/v1/avatar.
> 2. Upload an avatar with the URL field set to
>    http://169.254.169.254/latest/meta-data/iam/security-credentials/.
> 3. The server fetches the URL and returns the internal metadata response.
>
> Proof of concept (curl):
> curl -X POST https://example.atlassian.net/api/v1/avatar \
>   -H "Authorization: Bearer <user-token>" \
>   -d '{"url":"http://169.254.169.254/latest/meta-data/"}'
>
> Impact: server-side request forgery. The server made a request to the
> internal metadata endpoint and returned cloud credentials in the
> response. An unauthenticated attacker cannot trigger this, but any
> logged-in user can.
>
> Expected: the server rejects non-image URLs.
> Actual: the server fetches arbitrary URLs and returns the response.
>
> Environment: Chrome 126 on macOS 14. Reported by a bug-bounty hunter.

Expected agent output: **High band, High confidence, ESCALATE** (with a
human confirmation step). Factors: exploitability 1 (any logged-in user;
the report says unauthenticated attackers *cannot* trigger it) +
impact 2 (SSRF) = 3/4. **Likely duplicate of SEC-88** — the agent must
surface the link and recommend linking instead of opening a new issue.
Routing: Media team (component table). Missing evidence: none.

Note the deliberate trap in report B: an agent that skims "unauthenticated"
without reading "cannot trigger this" would score it Critical. Repro
scores it High — show that in the video; it is the rubric working, not
a mistake. (A genuinely unauthenticated RCE — see `test/triage.test.mjs` —
scores Critical.)

## Video beats (4:30–5:00)

3:30–4:30 the issue panel (same verdicts, read-only, works without Rovo)
+ the MCP tools from an external client (Claude Code / Cursor via
`https://mcp.atlassian.com/forge/<app-id>`). 4:30–5:00 install link + close.

## Unit-test reference

`npm test` runs the same two reports through the pure logic and asserts
the expected bands, plus an unauthenticated-RCE case (Critical), the
SEC-88 dedup hit, routing, and ADF flattening. 10/10 pass on this VM.
