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
// Teamwork Graph context is live again (23 Nov 2026) as the read-only
// `graph-context` action + panel section: the reporter's other reported
// work items, via the curated `atlassianUserReportedJiraWorkItems` query
// (src/twg.mjs). It enriches triage, never drives routing — routing stays
// the component->team table in rubric.js, with the project lead as fallback.
// A graph failure is reported as unavailable, never a panel error.

import api, { route } from '@forge/api';
import _Resolver from '@forge/resolver';
// @forge/resolver is CommonJS (exports.default = Resolver). With some bundler
// interop settings the default import lands as the module namespace object
// instead of the class ("resolver_out_namespaceObject is not a constructor",
// panel error 22 Nov 2026) — resolve the class defensively either way.
const Resolver = _Resolver.default ?? _Resolver;
import { adfToText, findDuplicates as scoreDuplicates, missingEvidence as listMissingEvidence, parseReport as parseReportText, scoreSeverity as scoreReportSeverity, triageReport } from './triage.mjs';
import { COMPONENT_TEAMS } from './rubric.mjs';
import { fetchReporterWork } from './twg.mjs';

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
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,components,labels,project,reporter`);
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

// Teamwork Graph context: other work items reported by the same reporter,
// so triage can spot repeat reporters and related reports. Read-only and
// best-effort — a graph failure returns available: false, never a throw.
export async function graphContext(event) {
  const issueKey = getInput(event, 'issueKey');
  const reporterAccountId = getInput(event, 'reporterAccountId');
  let reporter = null;
  let issue = null;
  if (reporterAccountId) {
    reporter = { accountId: String(reporterAccountId), displayName: null };
  } else if (issueKey) {
    issue = await fetchIssue(String(issueKey));
    reporter = issue.fields?.reporter || null;
  } else {
    throw new Error('Provide issueKey or reporterAccountId.');
  }
  if (!reporter?.accountId) return { issueKey: issueKey || null, reporter: null, available: false, items: [], error: 'no reporter on issue' };
  const result = await fetchReporterWork(api, reporter.accountId);
  const currentTitle = issue?.fields?.summary || null;
  const items = result.items.filter((it) => it.title !== currentTitle);
  return {
    issueKey: issueKey || null,
    reporter: { displayName: reporter.displayName || null, accountId: reporter.accountId },
    available: result.available,
    items,
    otherCount: items.length,
    error: result.error || null,
  };
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
  // Teamwork Graph context is best-effort: a graph failure must never
  // break the panel, so it is caught and reported as unavailable.
  // A GraphQL-level error (or an unparseable response) is also "unavailable",
  // never silently shown as "no other reports" — the two look identical in
  // the panel otherwise, and an empty result must mean the graph really
  // returned zero items.
  let graph = { available: false, items: [], error: 'not attempted' };
  try {
    const reporter = issue.fields?.reporter;
    if (reporter?.accountId) {
      const result = await fetchReporterWork(api, reporter.accountId);
      const items = result.items.filter((it) => it.title !== (issue.fields?.summary || ''));
      const failed = !result.available || (typeof result.error === 'string' && /^(graph error:|HTTP|empty response)/.test(result.error));
      console.log(`[repro twg] issue=${issueKey} reporter=${reporter.accountId} available=${result.available} rawItems=${result.items.length} shownItems=${items.length} error=${result.error || 'none'}`);
      graph = failed
        ? { available: false, reporterName: reporter.displayName || null, items: [], error: result.error || 'graph returned no usable data' }
        : { available: true, reporterName: reporter.displayName || null, items, error: null };
    } else {
      graph = { available: false, items: [], error: 'no reporter on issue' };
    }
  } catch (err) {
    graph = { available: false, items: [], error: err?.message || String(err) };
  }
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
    graph,
  };
});

export const handler = resolver.getDefinitions();
