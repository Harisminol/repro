---
name: repro-rubric
description: Severity rubric and missing-evidence checklist for security report triage. Use whenever triaging a security report in JSM or Jira, scoring its severity, or deciding whether it is ready to escalate. The rubric is deterministic and every factor must cite the report text.
---

# Repro — severity rubric and missing-evidence checklist

Use this skill when triaging a security report. It carries the procedure the
agent prompt points to. The scoring code in `src/rubric.js` implements the
same rubric; keep the two in sync when the team changes a factor.

## Procedure

1. Parse the report with the `parse-report` tool (component, versions,
   repro steps, claimed impact).
2. Dedup with `find-duplicates`. A `likely` verdict ends the triage: link
   the known issue instead of opening a new one.
3. Score with `score-severity`. Report the band AND the confidence.
4. List gaps with `missing-evidence`. Return the checklist to the reporter
   when escalation is blocked.
5. Route with `route-owner`. Name the owning team or say it cannot be
   determined yet.
6. Draft the triage summary. A human confirms before any write.

## The rubric (see references/rubric.md for the full tables)

Severity band = exploitability (0-2) + impact (0-2), total 0-4:
Critical 4, High 3, Medium 2, Low 1, Informational 0.

Confidence = reproduction evidence (0-2): version pinned, 2+ numbered
repro steps, PoC present. 2 = High, 1 = Medium, 0 = Low.

Escalation rule: escalate only when the band is Medium or higher AND
confidence is Medium or higher. Otherwise return the missing-evidence
checklist. A high-impact claim with no evidence is scored high but never
escalated — it is unproven until the evidence arrives.

## Missing evidence (see references/checklist.md)

Always blocking: affected version, numbered repro steps. Blocking for
High/Critical reports: PoC, demonstrated impact, account role (for
access-control reports). Never blocking: expected vs actual, environment.

## Tools

This skill uses the app's own read-only GET actions:

- `parse-report`
- `find-duplicates`
- `score-severity`
- `missing-evidence`
- `route-owner`

All five are also exposed over the app's MCP server (`repro-mcp`).
