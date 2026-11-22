// Unit tests for the pure triage logic (src/triage.js). No Forge, no network.
// Run: npm test   (node --test test/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, findDuplicates, missingEvidence, parseReport, routeOwner, scoreSeverity, triageReport } from '../src/triage.mjs';

// Demo report A — the vague one. Same bug as B, no evidence.
const VAGUE_REPORT = `URGENT!!! Login is broken, CRITICAL vulnerability. Anyone can get in.
Please fix ASAP. Reported by a customer.`;

// Demo report B — the same report, with a working repro and cited impact.
const REPRO_REPORT = `Title: SSRF in avatar upload reaches internal metadata endpoint

Affected version: 4.2.1
Component: upload / avatar

Steps to reproduce:
1. Log in as a normal user and open the avatar upload at /api/v1/avatar.
2. Upload an avatar with the URL field set to http://169.254.169.254/latest/meta-data/iam/security-credentials/.
3. The server fetches the URL and returns the internal metadata response.

Proof of concept (curl):
curl -X POST https://example.atlassian.net/api/v1/avatar -H "Authorization: Bearer <user-token>" -d '{"url":"http://169.254.169.254/latest/meta-data/"}'

Impact: server-side request forgery. The server made a request to the
internal metadata endpoint and returned cloud credentials in the response.
An unauthenticated attacker cannot trigger this, but any logged-in user can.

Expected: the server rejects non-image URLs.
Actual: the server fetches arbitrary URLs and returns the response.

Environment: Chrome 126 on macOS 14. Reported by a bug-bounty hunter.`;

const KNOWN_ISSUES = [
  { key: 'SEC-101', summary: 'Login bypass on 4.2.1 allows access without password', description: 'Authentication bypass in login', components: ['login'], labels: [] },
  { key: 'SEC-88', summary: 'Avatar upload SSRF to internal metadata endpoint', description: 'SSRF via avatar URL field, version 4.2.1', components: ['upload'], labels: [] },
  { key: 'SEC-77', summary: 'Checkout page shows wrong currency symbol', description: '', components: ['checkout'], labels: [] },
];

test('vague report: low band, low confidence, needs more evidence', () => {
  const parsed = parseReport(VAGUE_REPORT);
  assert.equal(parsed.versions.length, 0);
  assert.equal(parsed.reproSteps.length, 0);
  assert.equal(parsed.pocPresent, false);
  assert.equal(parsed.impactClasses.length, 0);

  const severity = scoreSeverity(parsed);
  assert.equal(severity.band, 'Low');
  assert.equal(severity.confidence, 'Low');
  assert.equal(severity.recommendation, 'NEEDS_MORE_EVIDENCE');
  assert.equal(severity.factors.find((f) => f.id === 'impact').score, 0);

  const missing = missingEvidence(parsed, severity);
  const ids = missing.map((m) => m.id);
  assert.ok(ids.includes('affected-version'));
  assert.ok(ids.includes('repro-steps'));
  assert.ok(missing.find((m) => m.id === 'affected-version').blocksEscalation);
});

test('report with repro: High band, high confidence, escalates', () => {
  const parsed = parseReport(REPRO_REPORT);
  assert.deepEqual(parsed.versions, ['4.2.1']);
  assert.equal(parsed.component, 'upload');
  assert.ok(parsed.reproSteps.length >= 2);
  assert.equal(parsed.pocPresent, true);
  assert.ok(parsed.impactClasses.some((c) => c.id === 'ssrf'));

  const severity = scoreSeverity(parsed);
  // Authenticated SSRF yielding cloud credentials: exploitability 1 (any
  // logged-in user; the report says unauthenticated attackers CANNOT
  // trigger it) + impact 2 = High, not Critical.
  assert.equal(severity.band, 'High');
  assert.equal(severity.confidence, 'High');
  assert.equal(severity.recommendation, 'ESCALATE');
  assert.equal(severity.factors.find((f) => f.id === 'exploitability').score, 1);
  assert.equal(severity.factors.find((f) => f.id === 'impact').score, 2);
  assert.ok(severity.factors.every((f) => f.evidence && f.evidence.length > 0));

  const missing = missingEvidence(parsed, severity);
  assert.equal(missing.length, 0);
});

test('unauthenticated RCE: Critical band, high confidence, escalates', () => {
  const rce = `Title: Unauthenticated RCE in the search endpoint

Affected version: 4.2.0

Steps to reproduce:
1. Send a POST to /api/v1/search with {"q": "$(id)"}.
2. The server returns the command output in the response.

Proof of concept:
curl -X POST https://example.atlassian.net/api/v1/search -d '{"q":"$(id)"}'

Impact: remote code execution as root, no login required.`;
  const parsed = parseReport(rce);
  assert.ok(parsed.impactClasses.some((c) => c.id === 'rce'));
  const severity = scoreSeverity(parsed);
  assert.equal(severity.band, 'Critical');
  assert.equal(severity.confidence, 'High');
  assert.equal(severity.recommendation, 'ESCALATE');
});

test('dedup: the repro report is a likely duplicate of SEC-88', () => {
  const parsed = parseReport(REPRO_REPORT);
  const dups = findDuplicates(parsed, KNOWN_ISSUES);
  assert.ok(dups.length >= 1);
  assert.equal(dups[0].key, 'SEC-88');
  assert.equal(dups[0].verdict, 'likely');
  assert.ok(dups[0].reasons.length >= 2);
});

test('dedup: the vague report matches nothing', () => {
  const parsed = parseReport(VAGUE_REPORT);
  const dups = findDuplicates(parsed, KNOWN_ISSUES);
  assert.equal(dups.length, 0);
});

test('dedup: an issue is never a duplicate of itself', () => {
  // SEC-1 is the issue being triaged; the JQL search returns it too.
  const self = { key: 'SEC-1', summary: 'Avatar upload SSRF to internal metadata endpoint', description: 'SSRF via avatar URL field, version 4.2.1', components: ['upload'], labels: [] };
  const parsed = parseReport(REPRO_REPORT);
  const dups = findDuplicates(parsed, [self, ...KNOWN_ISSUES], 'SEC-1');
  assert.ok(!dups.some((d) => d.key === 'SEC-1'));
  assert.equal(dups[0].key, 'SEC-88');
  assert.equal(dups[0].verdict, 'likely');
  const report = triageReport(REPRO_REPORT, [self, ...KNOWN_ISSUES], 'SEC-1');
  assert.ok(!report.summary.includes('SEC-1'));
  assert.equal(report.duplicates[0].key, 'SEC-88');
});

test('routing: upload component routes to the Media team', () => {
  const parsed = parseReport(REPRO_REPORT);
  const routing = routeOwner(parsed);
  assert.equal(routing.team, 'Media');
  assert.equal(routing.source, 'component-map');
});

test('routing: unknown component routes nowhere, with a reason', () => {
  const routing = routeOwner(parseReport('Something is wrong somewhere.'));
  assert.equal(routing.team, null);
  assert.equal(routing.source, 'unknown');
});

test('full pipeline: repro report is flagged as a likely duplicate', () => {
  const report = triageReport(REPRO_REPORT, KNOWN_ISSUES);
  assert.equal(report.recommendation, 'LIKELY_DUPLICATE');
  assert.equal(report.duplicates[0].key, 'SEC-88');
  assert.equal(report.routing.team, 'Media');
});

test('full pipeline: vague report needs more evidence', () => {
  const report = triageReport(VAGUE_REPORT, KNOWN_ISSUES);
  assert.equal(report.recommendation, 'NEEDS_MORE_EVIDENCE');
  assert.ok(report.missing.length >= 3);
});

test('adfToText flattens an issue description', () => {
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'SSRF in avatar upload' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Affected version: 4.2.1' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Upload an avatar URL' }] }] }] },
    ],
  };
  const text = adfToText(adf);
  assert.ok(text.includes('SSRF in avatar upload'));
  assert.ok(text.includes('4.2.1'));
  assert.ok(text.includes('Upload an avatar URL'));
  assert.equal(adfToText('plain string'), 'plain string');
  assert.equal(adfToText(null), '');
});

// --- Teamwork Graph response parsing (src/twg.mjs). No Forge, no network.
import { parseReporterWork, userAri, REPORTER_WORK_OPERATION } from '../src/twg.mjs';

test('twg: operation name follows the company_operation rule', () => {
  const [company, op] = REPORTER_WORK_OPERATION.split('_');
  assert.ok(company.length >= 3);
  assert.ok(op.length >= 4);
});

test('twg: userAri builds the identity ARI', () => {
  assert.equal(userAri('712020:abc'), 'ari:cloud:identity::user/712020:abc');
});

test('twg: parseReporterWork extracts items and page info', () => {
  const json = {
    data: {
      atlassianUserReportedJiraWorkItems: {
        edges: [
          { node: { id: 'ari:cloud:jira:x:issue/10001', title: 'Avatar upload SSRF', status: { name: 'To Do' } } },
          { node: { id: 'ari:cloud:jira:x:issue/10002', title: 'Login bypass', status: { name: 'To Do' } } },
          { node: { id: 'ari:cloud:jira:x:issue/10003', title: 'Checkout currency', status: null } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  };
  const parsed = parseReporterWork(json);
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.items[0].title, 'Avatar upload SSRF');
  assert.equal(parsed.items[0].status, 'To Do');
  assert.equal(parsed.items[2].status, null);
  assert.equal(parsed.hasNextPage, false);
});

test('twg: parseReporterWork tolerates empty and error shapes', () => {
  assert.deepEqual(parseReporterWork(null).items, []);
  assert.deepEqual(parseReporterWork({}).items, []);
  assert.deepEqual(parseReporterWork({ data: { atlassianUserReportedJiraWorkItems: { edges: [] } } }).items, []);
  const err = parseReporterWork({ errors: [{ message: 'missing scope' }] });
  assert.deepEqual(err.items, []);
  assert.match(err.reason, /missing scope/);
  const noTitle = parseReporterWork({ data: { atlassianUserReportedJiraWorkItems: { edges: [{ node: { id: 'x' } }] } } });
  assert.deepEqual(noTitle.items, []);
});
