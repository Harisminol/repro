// twg.mjs — Teamwork Graph client for Repro (pure logic + thin API call).
//
// Curated query only: work items reported by the same reporter, so triage
// can spot repeat reporters and related reports. No raw Cypher is ever sent
// (refused by the API). Read-only and best-effort: a graph failure, an
// empty result, or a missing scope must NEVER break the panel — callers
// treat { available: false } as "no graph context", not an error.
//
// Docs: developer.atlassian.com/platform/teamwork-graph/curated-queries/
// Operation names must be `<company>_<operation>` (company >= 3 chars,
// operation >= 4 chars). Curated queries cap `first` at 25.

export const REPORTER_WORK_OPERATION = 'repro_reporterWork';

export const REPORTER_WORK_QUERY = `query repro_reporterWork($userId: ID!) {
  atlassianUserReportedJiraWorkItems(userId: $userId, first: 25) {
    edges {
      node {
        ... on JiraWorkItem {
          id
          title
          status {
            name
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

export function userAri(accountId) {
  return `ari:cloud:identity::user/${accountId}`;
}

// Parse a Teamwork Graph response into plain items. Tolerant by design:
// unknown shapes, GraphQL errors, or empty edges all yield { items: [] }
// plus a reason string, never a throw.
export function parseReporterWork(json) {
  const empty = (reason) => ({ items: [], hasNextPage: false, reason });
  if (!json || typeof json !== 'object') return empty('empty response');
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    return empty(`graph error: ${json.errors.map((e) => e.message || 'unknown').join('; ')}`);
  }
  const field = json.data?.atlassianUserReportedJiraWorkItems;
  if (!field || !Array.isArray(field.edges)) return empty('no reported work items');
  const items = [];
  for (const edge of field.edges) {
    const node = edge?.node;
    if (!node || typeof node.title !== 'string') continue;
    items.push({ id: typeof node.id === 'string' ? node.id : null, title: node.title, status: node.status?.name ?? null });
  }
  return { items, hasNextPage: field.pageInfo?.hasNextPage === true, reason: items.length === 0 ? 'reporter has no other work items' : null };
}

const TRANSIENT = /RATE_LIMIT|THROTTL|429|502|503|504/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Call the curated query as the current user. Retries transient failures
// (rate limits return zero rows after ~128 calls in 20s, so we call rarely
// and back off). Returns { available, items, error? } — never throws.
export async function fetchReporterWork(api, accountId, { maxAttempts = 3 } = {}) {
  if (!accountId) return { available: false, items: [], error: 'no reporter accountId' };
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await api.asUser().requestTeamworkGraph(
        REPORTER_WORK_QUERY,
        { userId: userAri(accountId) },
        REPORTER_WORK_OPERATION,
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        if (!TRANSIENT.test(lastError) && res.status < 500) break;
      } else {
        const parsed = parseReporterWork(json);
        if (parsed.reason && parsed.reason.startsWith('graph error:') && TRANSIENT.test(parsed.reason)) {
          lastError = parsed.reason;
        } else {
          return { available: true, items: parsed.items, hasNextPage: parsed.hasNextPage, error: parsed.reason };
        }
      }
    } catch (err) {
      lastError = err?.message || String(err);
      if (!TRANSIENT.test(lastError)) break;
    }
    if (attempt < maxAttempts) await sleep(500 * attempt);
  }
  return { available: false, items: [], error: lastError };
}
