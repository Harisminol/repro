# Missing-evidence checklist (reference)

Mirrors `EVIDENCE_CHECKLIST` in `src/rubric.js`. When a report is not ready
to escalate, return the missing items as a checklist the reporter must
complete. Never invent the missing facts yourself.

| Item | Why it matters | Blocks escalation |
|---|---|---|
| Affected version / build | Without a version the team cannot tell whether the report is already fixed or still present | Always |
| Numbered reproduction steps (2+) | The minimum for anyone else to reproduce the issue | Always |
| Proof of concept (request/response, curl, screenshot) | Turns a claim into something the team can replay | High/Critical reports |
| Demonstrated impact (what data or action was actually reached) | The claimed impact class must be backed by what was actually reached, not assumed | High/Critical reports |
| Account role used during testing | Access-control reports are meaningless without knowing which role acted | High/Critical access-control reports (IDOR, privilege escalation, auth bypass) |
| Expected vs actual behaviour | One line each makes the bug unambiguous for the fixer | Never |
| Environment (browser/app, OS) | Helps reproduce client-side issues | Never |
