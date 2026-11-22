// index.js — Forge function handlers for Repro.
//
// All handlers are READ-ONLY. They fetch data (an issue, JQL candidates, a
// project lead) and run the pure triage logic in triage.js. Nothing here
// transitions, assigns, comments, or otherwise writes: the agent drafts a
// triage summary and a human confirms before any write happens.
//
// Action handlers receive their inputs as the first argument (Forge passes
// the action inputs; getInput() also checks payload/input wrappers so the
// handlers stay robust across invocation paths).
//
// Teamwork Graph routing was REMOVED on 22 Nov 2026: the hook was dead code
// behind a disabled flag and its mere presence triggered a forge lint
// warning (teamwork-graph-scopes). Routing is the component->team table in
// rubric.js, with the project lead as fallback.

import api, { route } from '@forge/api';
import _Resolver from '@forge/resolver';
// @forge/resolver is CommonJS (exports.default = Resolver). With some bundler
// interop settings the default import lands as the module namespace object
// instead of the class ("resolver_out_namespaceObject is not a constructor",
// panel error 22 Nov 2026) — resolve the class defensively either way.
const Resolver = _Resolver.default ?? _Resolver;
import { adfToText, findDuplicates as scoreDuplicates, missingEvidence as listMissingEvidence, parseReport as parseReportText, scoreSeverity as scoreReportSeverity, triageReport } from './triage.mjs';
import { COMPONENT_TEAMS } from './rubric.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInput(event, name) {
  if (!event) return undefined;
  if (event[name] !== undefined) return event[name];
  if (event.payload && event.payload[name] !== undefined) return event.payload[name];
  if (event.input && event.input[name] !== undefined) return event.input[name];
  return undefined;
}

async function fetchIssue(issueKey) {
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,components,labels,project`);
  if (!res.ok) throw new Error(`Failed to fetch issue ${issueKey}: HTTP ${res.status}`);
  return res.json();
}

function issueText(issue) {
  const parts = [issue.fields?.summary || ''];
  if (issue.fields?.description) parts.push(adfToText(issue.fields.description));
  return parts.join('\n').trim();
}

async function reportFrom(event) {
  const reportText = getInput(event, 'reportText');
  const issueKey = getInput(event, 'issueKey');
  if (reportText) return { text: String(reportText), issueKey: issueKey || null };
  if (issueKey) {
    const issue = await fetchIssue(String(issueKey));
    return { text: issueText(issue), issueKey: String(issueKey), issue };
  }
  throw new Error('Provide reportText or issueKey.');
}

async function searchCandidates(parsed, maxResults = 10) {
  const terms = [];
  if (parsed.component) terms.push(parsed.component);
  for (const cls of parsed.impactClasses.slice(0, 2)) terms.push(cls.label);
  for (const version of parsed.versions.slice(0, 1)) terms.push(version);
  if (!terms.length) return [];
  const jql = terms
    .map((t) => `text ~ "${String(t).replace(/["\\]/g, '')}"`)
    .join(' OR ');
  // NOTE: requestJira REQUIRES the URL to be built with the `route` tag from
  // '@forge/api' — a plain string throws "You must create your route using
  // the 'route' export" (panel error, 22 Nov 2026). The tag encodes
  // interpolated query values itself, so pass the RAW jql (no pre-encoding).
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql?jql=${jql}&maxResults=${maxResults}&fields=summary,description,components,labels`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.issues || []).map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || '',
    description: adfToText(issue.fields?.description),
    components: (issue.fields?.components || []).map((c) => c.name),
    labels: issue.fields?.labels || [],
  }));
}

// ---------------------------------------------------------------------------
// Action handlers (all GET, all read-only)
// ---------------------------------------------------------------------------

export async function parseReport(event) {
  const { text, issueKey } = await reportFrom(event);
  const parsed = parseReportText(text);
  return { issueKey, ...parsed, rawText: undefined };
}

export async function findDuplicates(event) {
  const { text, issueKey } = await reportFrom(event);
  const parsed = parseReportText(text);
  const candidates = await searchCandidates(parsed);
  const duplicates = scoreDuplicates(parsed, candidates, issueKey);
  return { issueKey, component: parsed.component, impactClasses: parsed.impactClasses.map((c) => c.id), duplicates };
}

export async function scoreSeverity(event) {
  const { text, issueKey } = await reportFrom(event);
  const parsed = parseReportText(text);
  const severity = scoreReportSeverity(parsed);
  return {
    issueKey,
    band: severity.band,
    confidence: severity.confidence,
    total: severity.total,
    recommendation: severity.recommendation,
    rationale: severity.rationale,
    factors: severity.factors,
  };
}

export async function missingEvidence(event) {
  const { text, issueKey } = await reportFrom(event);
  const parsed = parseReportText(text);
  const severity = scoreReportSeverity(parsed);
  const missing = listMissingEvidence(parsed, severity);
  return {
    issueKey,
    band: severity.band,
    confidence: severity.confidence,
    missing,
    blockingCount: missing.filter((m) => m.blocksEscalation).length,
  };
}

export async function routeOwner(event) {
  const component = getInput(event, 'component');
  const projectKey = getInput(event, 'projectKey');
  const issueKey = getInput(event, 'issueKey');
  let parsed = null;
  if (!component && issueKey) {
    const issue = await fetchIssue(String(issueKey));
    parsed = parseReportText(issueText(issue));
  } else if (!component) {
    throw new Error('Provide component, or issueKey to derive it from the report.');
  }
  const resolvedComponent = component || parsed.component;

  if (resolvedComponent && COMPONENT_TEAMS[resolvedComponent]) {
    return { component: resolvedComponent, team: COMPONENT_TEAMS[resolvedComponent], source: 'component-map', reason: `Component "${resolvedComponent}" maps to the ${COMPONENT_TEAMS[resolvedComponent]} team.` };
  }

  if (projectKey) {
    try {
      const res = await api.asUser().requestJira(route`/rest/api/3/project/${projectKey}`);
      if (res.ok) {
        const project = await res.json();
        const lead = project.lead;
        if (lead) return { component: resolvedComponent, team: null, owner: lead.displayName, ownerAccountId: lead.accountId, source: 'project-lead', reason: `No component mapping; falling back to the project lead of ${projectKey}.` };
      }
    } catch {
      // fall through to unknown
    }
  }

  return { component: resolvedComponent, team: null, source: 'unknown', reason: 'No component could be identified, so no owning team can be routed to yet. Ask the reporter for the affected component.' };
}

// ---------------------------------------------------------------------------
// Issue panel resolver (UI Kit 2)
// ---------------------------------------------------------------------------

const resolver = new Resolver();

resolver.define('getTriage', async ({ payload }) => {
  const issueKey = payload?.issueKey;
  if (!issueKey) throw new Error('issueKey is required.');
  const issue = await fetchIssue(String(issueKey));
  const text = issueText(issue);
  const candidates = await searchCandidates(parseReportText(text));
  const report = triageReport(text, candidates, String(issueKey));
  return {
    issueKey: String(issueKey),
    summary: issue.fields?.summary || '',
    band: report.severity.band,
    confidence: report.severity.confidence,
    total: report.severity.total,
    recommendation: report.recommendation,
    rationale: report.severity.rationale,
    summaryLine: report.summary,
    factors: report.severity.factors,
    missing: report.missing,
    duplicates: report.duplicates,
    routing: report.routing,
  };
});

export const handler = resolver.getDefinitions();
