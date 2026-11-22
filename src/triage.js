// triage.js — pure triage logic for Repro. No Forge imports, so this file
// is unit-testable with plain node (`npm test`). The Forge handlers in
// index.js only fetch data (issue text, JQL candidates, project lead) and
// call these functions.
//
// Pipeline: parseReport -> scoreSeverity -> missingEvidence -> findDuplicates
// -> routeOwner. triageReport() runs the whole pipeline for the issue panel.

import { BANDS, COMPONENT_KEYWORDS, EVIDENCE_CHECKLIST, IMPACT_CLASSES } from './rubric.js';

const VERSION_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/g;
const URL_PATH_RE = /(?:^|[\s"'`])(?:https?:\/\/[^\s)>\]]+?)?(\/(?:api|v\d+|admin|auth|login|checkout|users?|account)[/\w.\-]*)/gi;
const STEP_LINE_RE = /^\s*(?:\d+[.)]|[-*•])\s+\S/m;
const NUMBERED_LINE_RE = /^\s*\d+[.)]\s+(.+)$/;
const BULLET_LINE_RE = /^\s*[-*•]\s+(.+)$/;

const STOPWORDS = new Set(
  'the a an and or of to in on for with is are was were be been it its this that these those from by at as at not no yes if then than when where which who what how can could should would will just only also more most very then there here their they he she we you our your my his her'.split(' '),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(text) {
  return String(text || '').split(/\r?\n/);
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// First line/sentence containing `needle` (case-insensitive), trimmed to 160 chars.
function evidenceLine(text, needle) {
  const lower = String(text || '').toLowerCase();
  const idx = lower.indexOf(String(needle).toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, String(text).lastIndexOf('\n', idx) + 1);
  let end = String(text).indexOf('\n', idx);
  if (end < 0) end = String(text).length;
  const line = String(text).slice(start, end).trim();
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

// Atlassian Document Format -> plain text (issue descriptions are ADF).
export function adfToText(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'text') {
      out.push(node.text || '');
      return;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'codeBlock'].includes(node.type)) out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// 1. Parse a free-text security report into structured fields.
// ---------------------------------------------------------------------------

export function parseReport(rawText) {
  const text = String(rawText || '');
  const result = {
    component: null,
    componentEvidence: null,
    versions: [],
    reproSteps: [],
    impactClasses: [],
    claimedImpact: null,
    reporter: null,
    signals: { unauthenticated: false, requiresAuth: false, userInteraction: false, requiresAdmin: false },
    pocPresent: false,
    rawText: text,
  };

  // Versions (unique, max 10). IP addresses are not versions: skip a match
  // that is part of a longer dotted number (e.g. 169.254.169.254).
  const versions = new Set();
  for (const m of text.matchAll(VERSION_RE)) {
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/^\.\d/.test(after)) continue; // followed by .N -> first octets of an IP
    if (/\d\.$/.test(before)) continue; // preceded by N. -> later octets of an IP
    versions.add(m[1]);
    if (versions.size >= 10) break;
  }
  result.versions = [...versions];

  // Repro steps: prefer a "steps to reproduce" section, else numbered lines anywhere.
  const ls = lines(text);
  const sectionStart = ls.findIndex((l) => /steps?\s+to\s+reproduce|how\s+to\s+reproduce|\brepro\b/i.test(l));
  const scan = sectionStart >= 0 ? ls.slice(sectionStart) : ls;
  for (const line of scan) {
    const numbered = line.match(NUMBERED_LINE_RE);
    const bullet = line.match(BULLET_LINE_RE);
    if (numbered) result.reproSteps.push(numbered[1].trim());
    else if (bullet && sectionStart >= 0) result.reproSteps.push(bullet[1].trim());
    if (result.reproSteps.length >= 20) break;
  }
  if (result.reproSteps.length === 0 && STEP_LINE_RE.test(text)) {
    // Fallback: any numbered line in the whole text.
    for (const line of ls) {
      const numbered = line.match(NUMBERED_LINE_RE);
      if (numbered) result.reproSteps.push(numbered[1].trim());
      if (result.reproSteps.length >= 20) break;
    }
  }

  // Impact classes: first keyword hit per class, with the evidence line.
  for (const cls of IMPACT_CLASSES) {
    for (const kw of cls.keywords) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        result.impactClasses.push({ id: cls.id, label: cls.label, weight: cls.weight, evidence: evidenceLine(text, kw) });
        break;
      }
    }
  }

  // Claimed impact: the "impact" section, else the first sentence with an impact keyword.
  const impactSection = ls.findIndex((l) => /^\s*impact\b/i.test(l));
  if (impactSection >= 0) {
    result.claimedImpact = ls.slice(impactSection + 1, impactSection + 4).join(' ').trim() || null;
  } else {
    const hit = sentences(text).find((s) => result.impactClasses.some((c) =>
      IMPACT_CLASSES.find((x) => x.id === c.id).keywords.some((kw) => s.toLowerCase().includes(kw.toLowerCase()))));
    result.claimedImpact = hit || null;
  }

  // Reporter.
  const reporterMatch = text.match(/reported\s+by[:\s]+([^\n\r]+)/i);
  if (reporterMatch) result.reporter = reporterMatch[1].trim();

  // Auth / interaction signals. Negation matters: "an unauthenticated
  // attacker cannot trigger this" is NOT an unauthenticated finding.
  const lower = text.toLowerCase();
  const hasUnauthSentence = sentences(text).some((s) =>
    /(unauthenticated|without (logging in|auth)|no auth|no login|anonymous|logged[- ]out)/i.test(s) &&
    !/(cannot|can not|can't|never|unable|not (be )?(triggered|exploited|reached)|no (way|one) (can|to))/i.test(s));
  result.signals.unauthenticated = hasUnauthSentence;
  result.signals.requiresAuth = /(logged in|authenticated|as a (normal |low[- ]privileged |regular )user|with a (normal |standard )account)/i.test(lower);
  result.signals.userInteraction = /(victim (must |needs to )?clicks?|user (must |needs to )?clicks?|open the link|visit (the |this )?page|trick(ed|ing)? (a |the )?user)/i.test(lower);
  result.signals.requiresAdmin = /(admin(istrator)? (account|role|access|user)|requires admin|as an admin)/i.test(lower);

  // PoC present.
  result.pocPresent = /(curl\b|proof of concept|\bpoc\b|http request|request:|response:|screenshot|burp|har file|reproduce with)/i.test(lower);

  // Component: keyword table first (occurrences counted, ties broken by
  // first mention in the text), then a URL/API path, else null.
  let bestComponent = null;
  let bestCount = 0;
  let bestPos = Infinity;
  for (const [component, { keywords }] of Object.entries(COMPONENT_KEYWORDS)) {
    let count = 0;
    let firstPos = Infinity;
    let hitLine = null;
    for (const kw of keywords) {
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = [...lower.matchAll(re)];
      if (matches.length > 0) {
        count += matches.length;
        firstPos = Math.min(firstPos, matches[0].index);
        hitLine = hitLine || evidenceLine(text, kw);
      }
    }
    if (count > bestCount || (count === bestCount && count > 0 && firstPos < bestPos)) {
      bestCount = count;
      bestPos = firstPos;
      bestComponent = component;
      result.componentEvidence = hitLine;
    }
  }
  if (bestComponent) {
    result.component = bestComponent;
  } else {
    const pathMatch = [...text.matchAll(URL_PATH_RE)].map((m) => m[1]).find(Boolean);
    if (pathMatch) {
      result.component = pathMatch.split('/').filter(Boolean)[0] || pathMatch;
      result.componentEvidence = evidenceLine(text, pathMatch);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. Score severity with the transparent rubric.
// ---------------------------------------------------------------------------

export function scoreSeverity(parsed) {
  const impact = parsed.impactClasses.reduce((max, c) => Math.max(max, c.weight), 0);

  let exploitability;
  let exploitReason;
  if (parsed.signals.requiresAdmin) {
    exploitability = 0;
    exploitReason = 'Report says an admin/high-privileged account is required.';
  } else if (parsed.signals.unauthenticated && !parsed.signals.userInteraction) {
    exploitability = 2;
    exploitReason = 'Report says the issue is reachable unauthenticated with no user interaction.';
  } else if (parsed.signals.unauthenticated && parsed.signals.userInteraction) {
    exploitability = 1;
    exploitReason = 'Reachable unauthenticated, but needs a victim to click or visit a page.';
  } else if (parsed.signals.requiresAuth || parsed.signals.userInteraction) {
    exploitability = 1;
    exploitReason = 'Requires an authenticated session or user interaction.';
  } else {
    exploitability = 1;
    exploitReason = 'No auth signal in the report; assumed an authenticated low-privileged user (verify).';
  }

  const rawEvidence = (parsed.versions.length > 0 ? 1 : 0) + (parsed.reproSteps.length >= 2 ? 1 : 0) + (parsed.pocPresent ? 1 : 0);
  const evidence = Math.min(2, rawEvidence);
  const evidenceReason = [
    parsed.versions.length > 0 ? `version pinned (${parsed.versions[0]})` : 'no version pinned',
    parsed.reproSteps.length >= 2 ? `${parsed.reproSteps.length} repro steps` : parsed.reproSteps.length === 1 ? 'only 1 repro step' : 'no repro steps',
    parsed.pocPresent ? 'PoC present' : 'no PoC',
  ].join('; ');

  const total = exploitability + impact;
  const band = BANDS.find((b) => total >= b.min).band;
  const confidence = evidence === 2 ? 'High' : evidence === 1 ? 'Medium' : 'Low';

  const factors = [
    {
      id: 'exploitability',
      label: 'Exploitability',
      score: exploitability,
      max: 2,
      evidence: parsed.signals.unauthenticated
        ? evidenceLine(parsed.rawText, 'unauthenticated') || evidenceLine(parsed.rawText, 'without') || exploitReason
        : exploitReason,
      reason: exploitReason,
    },
    {
      id: 'impact',
      label: 'Impact',
      score: impact,
      max: 2,
      evidence: parsed.impactClasses[0]?.evidence || 'No recognized impact class in the report text.',
      reason: parsed.impactClasses.length > 0
        ? `Strongest matched impact class: ${parsed.impactClasses.map((c) => c.label).join(', ')}.`
        : 'No impact class matched; impact cannot be scored above 0 until the report states what breaks.',
    },
    {
      id: 'evidence',
      label: 'Reproduction evidence',
      score: evidence,
      max: 2,
      evidence: evidenceReason,
      reason: 'Evidence sets confidence, not the band: a high-impact claim with no evidence stays unproven.',
    },
  ];

  let recommendation;
  if (band === 'Informational') {
    recommendation = 'LOW_PRIORITY';
  } else if (confidence === 'Low') {
    recommendation = 'NEEDS_MORE_EVIDENCE';
  } else if (band === 'Medium' || band === 'High' || band === 'Critical') {
    recommendation = 'ESCALATE';
  } else {
    recommendation = 'LOW_PRIORITY';
  }

  return {
    factors,
    exploitability,
    impact,
    evidence,
    total,
    band,
    confidence,
    recommendation,
    rationale: `Band ${band} (exploitability ${exploitability} + impact ${impact} = ${total}/4) with ${confidence} confidence (evidence ${evidence}/2). ` +
      (recommendation === 'ESCALATE'
        ? 'Meets the escalation bar; a human still confirms before any transition or assignment.'
        : recommendation === 'NEEDS_MORE_EVIDENCE'
          ? 'Does not meet the escalation bar yet: return the missing-evidence checklist to the reporter first.'
          : 'Below the escalation bar; log and close or track as low priority.'),
  };
}

// ---------------------------------------------------------------------------
// 3. List exactly what reproduction evidence is missing.
// ---------------------------------------------------------------------------

export function missingEvidence(parsed, severity) {
  const band = severity?.band || 'Informational';
  const highBand = band === 'High' || band === 'Critical';
  const impactIds = new Set(parsed.impactClasses.map((c) => c.id));
  const missing = [];

  for (const item of EVIDENCE_CHECKLIST) {
    let present = false;
    switch (item.id) {
      case 'affected-version': present = parsed.versions.length > 0; break;
      case 'repro-steps': present = parsed.reproSteps.length >= 2; break;
      case 'poc': present = parsed.pocPresent; break;
      case 'impact-demo': present = parsed.claimedImpact !== null && parsed.impactClasses.length > 0; break;
      case 'account-role': present = /(as a |as an |role[:\s])\w+ (user|account|role)/i.test(parsed.rawText) || /logged in as/i.test(parsed.rawText); break;
      case 'expected-vs-actual': present = /(expected|should (happen|be)|actual|instead)/i.test(parsed.rawText); break;
      case 'environment': present = /(browser|chrome|firefox|safari|edge|windows|macos|linux|android|ios|app version|os:)/i.test(parsed.rawText); break;
      default: present = true;
    }
    if (present) continue;
    if (item.onlyFor && !item.onlyFor.some((id) => impactIds.has(id))) continue;
    const blocks = item.blocksEscalation === 'always' || (item.blocksEscalation === 'high-only' && highBand);
    missing.push({ id: item.id, label: item.label, why: item.why, blocksEscalation: blocks });
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 4. Dedup against existing Jira issues.
// ---------------------------------------------------------------------------

export function findDuplicates(parsed, issues) {
  const reportTokens = new Set(tokenize(parsed.rawText));
  const scored = (issues || []).map((issue) => {
    const haystack = [issue.summary || '', issue.description || '', (issue.components || []).join(' '), (issue.labels || []).join(' ')].join(' ').toLowerCase();
    let score = 0;
    const reasons = [];

    if (parsed.component && haystack.includes(parsed.component.toLowerCase())) {
      score += 3;
      reasons.push(`same component (${parsed.component})`);
    }
    for (const cls of parsed.impactClasses) {
      const hit = IMPACT_CLASSES.find((x) => x.id === cls.id).keywords.find((kw) => haystack.includes(kw.toLowerCase()));
      if (hit) {
        score += 3;
        reasons.push(`same impact class (${cls.label})`);
        break;
      }
    }
    for (const version of parsed.versions) {
      if (haystack.includes(version.toLowerCase())) {
        score += 2;
        reasons.push(`same version (${version})`);
        break;
      }
    }
    const issueTokens = new Set(tokenize(issue.summary || ''));
    const overlap = [...issueTokens].filter((t) => reportTokens.has(t)).length;
    const union = new Set([...issueTokens, ...reportTokens]).size;
    const jaccard = union > 0 ? overlap / union : 0;
    const keywordScore = Math.round(jaccard * 2);
    if (keywordScore > 0) {
      score += keywordScore;
      reasons.push(`keyword overlap (${overlap} shared terms)`);
    }

    return {
      key: issue.key,
      summary: issue.summary || '',
      score,
      reasons,
      // A single weak signal (component alone = 3) is not enough to surface.
      verdict: score >= 6 ? 'likely' : score >= 4 ? 'possible' : 'unlikely',
    };
  });

  return scored
    .filter((c) => c.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ---------------------------------------------------------------------------
// 5. Route to the owning team (component map; Teamwork Graph overrides it
//    in index.js when available — this pure function is the fallback).
// ---------------------------------------------------------------------------

export function routeOwner(parsed) {
  if (parsed.component && COMPONENT_KEYWORDS[parsed.component]) {
    return {
      team: COMPONENT_KEYWORDS[parsed.component].team,
      component: parsed.component,
      source: 'component-map',
      reason: `Component "${parsed.component}" maps to the ${COMPONENT_KEYWORDS[parsed.component].team} team in the team-configurable table.`,
    };
  }
  return {
    team: null,
    component: parsed.component,
    source: 'unknown',
    reason: 'No component could be identified from the report, so no owning team can be routed to yet. Ask the reporter for the affected component.',
  };
}

// ---------------------------------------------------------------------------
// Full pipeline (used by the issue panel resolver).
// ---------------------------------------------------------------------------

export function triageReport(rawText, knownIssues) {
  const parsed = parseReport(rawText);
  const severity = scoreSeverity(parsed);
  const missing = missingEvidence(parsed, severity);
  const duplicates = findDuplicates(parsed, knownIssues || []);
  const routing = routeOwner(parsed);
  const likelyDuplicate = duplicates.some((d) => d.verdict === 'likely');
  return {
    parsed,
    severity,
    missing,
    duplicates,
    routing,
    recommendation: likelyDuplicate ? 'LIKELY_DUPLICATE' : severity.recommendation,
    summary: likelyDuplicate
      ? `Likely a duplicate of ${duplicates[0].key} (${duplicates[0].summary}). Link it instead of opening a new issue.`
      : severity.rationale,
  };
}
