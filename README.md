# Repro — Security Report Triage Agent for JSM/Jira

Codegeist 2026 entry (Apps for Software Teams). Bonus targets: Best Agents
(Rovo) + Best app with Atlassian MCP. One app, one submission, two bonus
shots. See `../WINNING-IDEAS.md` §2 #1 for the win-probability reasoning and
`../NOVELTY.md` §3 for the novelty case.

## What it does

A Rovo agent (`rovo:agent`) + the same tools over `rovo:mcp` + a small
UI Kit 2 issue panel. Given a security report (or asked about one), it:

1. **Parses** the report into structured fields — affected component,
   versions, repro steps, claimed impact (`parse-report`).
2. **Dedups** it against existing Jira issues so a re-report of a known
   issue is caught with the link (`find-duplicates`).
3. **Scores severity** with a transparent, team-configurable rubric where
   every factor cites the exact report text it rests on
   (`score-severity`, rubric in `src/rubric.js` + `skills/repro-rubric/`).
4. **Lists exactly what reproduction evidence is missing** as a checklist
   the reporter must complete before escalation (`missing-evidence`).
5. **Routes** to the owning team — component table by default, Teamwork
   Graph when enabled, project lead as a last fallback (`route-owner`).
6. **Drafts** a structured triage summary. **A human confirms before any
   transition or assignment.** All agent tools are read-only GET.

No Forge LLM calls, no egress, all-Forge. Works without Teamwork Graph
and without Rovo (the panel + MCP tools are usable on their own).

## Files

```
manifest.yml                  app declaration (modules, scopes, resources)
package.json                  @forge/* deps (resolved: api 5.3.0, bridge 5.17.0,
                              react 11.17.0, resolver 1.8.0)
src/
  index.js                    Forge handlers (read-only) + panel resolver
  triage.js                   pure triage logic (parse/score/dedup/route)
  rubric.js                   team-configurable rubric data
  frontend/index.jsx          UI Kit 2 issue panel (read-only)
resources/prompt.txt          rovo:agent prompt (single source of truth)
skills/repro-rubric/
  SKILL.md                    rubric + procedure for the agent
  references/rubric.md        rubric tables (mirrors src/rubric.js)
  references/checklist.md     missing-evidence checklist
test/triage.test.mjs          10 unit tests (node --test)
scripts/validate-manifest.py  cross-reference validation (forge lint needs login)
DEMO.md                       demo script + seed data
```

## Validation status (22 Nov 2026, this VM)

- `npm test` — **10/10 pass** (vague report → Low/Low/NEEDS_MORE_EVIDENCE;
  same report with repro → High/High/ESCALATE; unauthenticated RCE →
  Critical; dedup finds SEC-88; routing; ADF flattening).
- `npm install` — **OK**, 554 packages, all @forge deps resolve.
- Frontend JSX — **OK** (esbuild transform, no errors).
- `python3 scripts/validate-manifest.py` — **OK**: 6 functions, 5 actions,
  1 agent, 1 skill, 1 mcp, 1 panel, 2 resources, 3 scopes; every
  cross-reference valid; all verbs GET; all inputs `required: false`
  (FRGE-1601); names within limits; skill dir has no scripts.
- `forge lint` — **could not run: it demands a login** (`Error: Not logged
  in...`), and CLI auth is blocked on this VM (see below). The manifest was
  instead validated by hand against the CLI's own bundled schema
  (`@forge/cli/.../@forge/manifest/out/schema/manifest.d.ts`) and the
  interpolator source — this caught and fixed two real schema errors
  (prompt must be a `resource:` *string*, skill uses `source.dir` not
  `resource:`). The YAML parses (lint reached the interpolator stage),
  and the prompt resource string resolves to `resources/prompt.txt`.
- **Not yet verified live** (needs CLI auth): `forge deploy`, install on
  the dev site, the agent answering in Rovo Chat, MCP tools from an
  external client, the panel rendering on a real issue.

## The auth blocker (what still needs CLI auth)

`forge whoami` / `forge create` fail on this VM with `UserNotFoundError`:
the stored token reaches the CLI only as a surrogate, the CLI uses Basic
auth (surrogate hidden inside base64), and Atlassian shows the token as
"Never Accessed". Do NOT fight this from here; it needs a working login
on a machine where the token can be presented directly.

Once login works, the finish line is:

1. `forge register` (or `forge create` and copy the generated `app.id`
   into `manifest.yml` — the manifest currently carries the placeholder
   `ari:cloud:ecosystem::app/00000000-0000-0000-0000-000000000000`).
2. `forge lint` (should now pass — re-run it; it is the real gate).
3. Seed demo data on the trial site (see DEMO.md), then
   `forge deploy` → production.
4. Developer console → Distribution → Sharing → copy the installation
   link → test-install on a fresh site → fix whatever the install
   screen or a judge's test shows.
5. Demo video (< 5 min, public YouTube) + Devpost submission with the
   App ID + installation link. Deadline 23 Dec 2026 03:00 WIB.

Also still open on the user side: free Cloud Developer License (needed
for the Forge developer record — `whoami` returns UserNotFoundError
without it), a Standard/Premium trial dev site (Rovo is paid-only), and
Devpost "Join Hackathon" registration.

## Teamwork Graph (optional, off by default)

Routing works from the component→team table in `src/rubric.js` and falls
back to the project lead. To enable TWG routing: verify a curated query
in the TWG query builder, paste it into `TWG_QUERY` in `src/index.js`,
set `TWG_ENABLED = true`, and add `read:graph:issue:jira`,
`read:graph:team:atlassian`, `read:graph:user:atlassian` to the manifest
(needs an org-admin grant at install). Empty TWG results degrade to the
component map — TWG never blocks triage.

## Design decisions worth knowing

- **GET-only actions, `required: false` inputs** — FRGE-1601: non-GET
  action verbs do not reliably fire.
- **3 scopes, all read-only** — `read:jira-work`, `read:jira-user`,
  `search:jira`. Minimal install friction; every scope is used by a
  handler in `src/index.js`.
- **No license in the manifest, no Marketplace listing** — either would
  break the installation-link flow the judges use.
- **Rubric lives in code (`src/rubric.js`), mirrored in the skill** —
  the code scores deterministically; the agent narrates from the same
  tables. Change one, change both.
- **Kiro CLI was not used for this build** — the scaffold is fully
  spec-driven from STUDY.md/WINNING-IDEAS.md; direct authoring cost
  0 credits (credits expire 31 Dec 2026, balance unknown).

## Deploy dari HP (GitHub Codespaces)

Tanpa laptop: buka repo ini di GitHub → **Code → Codespaces → Create codespace on the default branch**
(mesin 2-core; akun GitHub Free sudah termasuk 120 core-hours/bulan — deploy cuma butuh 1–2 jam).
Forge CLI ter-install otomatis saat codespace dibuat.

Di terminal codespace, jalankan:

```bash
bash codespace-deploy.sh
```

Tempel API token Atlassian (token "Codegeist-2", kedaluwarsa 29 Nov 2026) saat diminta.
Script ini: login → register app → lint → deploy (development) → install ke
`harisminol-dev.atlassian.net` (Jira). Kalau ada error, kirim output terakhirnya.
