// rubric.js — the team-configurable severity rubric for Repro.
//
// This file is the single source of truth for scoring. The agent's skill
// (skills/repro-rubric/references/rubric.md) documents the SAME rubric in
// prose for the Rovo agent's narrative — keep the two in sync when you
// change a factor, a weight, or a threshold.
//
// Design (from WINNING-IDEAS.md / NOVELTY.md):
//   severity band  = exploitability (0-2) + impact (0-2)  -> 0-4
//   confidence     = evidence completeness (0-2)          -> Low / Medium / High
//   escalation     = band >= Medium AND confidence >= Medium, otherwise the
//                    report goes back to the reporter with the missing-evidence
//                    checklist. A high-impact report with no evidence is scored
//                    high but NOT escalated until the evidence arrives.
// Every factor cites the exact report text it rests on. No black-box score.

// Impact classes. `weight` is the impact-factor contribution (0-2).
// `keywords` are matched case-insensitively against the report text.
export const IMPACT_CLASSES = [
  { id: 'rce', label: 'Remote code execution', weight: 2, keywords: ['remote code execution', 'rce', 'code execution', 'command injection', 'arbitrary command', 'deserialisation', 'deserialization'] },
  { id: 'auth-bypass', label: 'Authentication bypass', weight: 2, keywords: ['authentication bypass', 'auth bypass', 'login bypass', 'bypass login', 'bypass authentication', 'without a password', 'without password', 'no password required'] },
  { id: 'privilege-escalation', label: 'Privilege escalation', weight: 2, keywords: ['privilege escalation', 'privesc', 'escalate privilege', 'become admin', 'gain admin', 'becomes admin'] },
  { id: 'data-exfiltration', label: 'Sensitive data exfiltration', weight: 2, keywords: ['exfiltrat', 'dump the database', 'download user data', 'access other users', "read other users'", 'read another user', 'credit card', 'password hash', 'personal data of'] },
  { id: 'sqli', label: 'SQL injection', weight: 2, keywords: ['sql injection', 'sqli', 'union select', 'or 1=1'] },
  { id: 'ssrf', label: 'Server-side request forgery', weight: 2, keywords: ['ssrf', 'server-side request forgery', 'server side request forgery', '169.254.169.254', 'metadata endpoint'] },
  { id: 'idor', label: 'Broken access control / IDOR', weight: 1, keywords: ['idor', 'insecure direct object', 'broken access control', 'change the id', 'change the user id', 'change the order id', 'object reference', 'access another user'] },
  { id: 'xss', label: 'Cross-site scripting', weight: 1, keywords: ['cross-site scripting', 'xss', 'stored xss', 'reflected xss'] },
  { id: 'csrf', label: 'Cross-site request forgery', weight: 1, keywords: ['csrf', 'cross-site request forgery'] },
  { id: 'dos', label: 'Denial of service', weight: 1, keywords: ['denial of service', 'dos attack', 'crash the server', 'exhaust', 'rate limit'] },
  { id: 'misconfig', label: 'Security misconfiguration', weight: 1, keywords: ['misconfigur', 'public bucket', 'open s3', 'default password', 'default credential', 'debug mode enabled'] },
  { id: 'info-disclosure', label: 'Information disclosure', weight: 0, keywords: ['information disclosure', 'info leak', 'version disclosure', 'stack trace', 'error message leaks', 'verbose error'] },
];

// Severity bands from exploitability + impact (0-4).
export const BANDS = [
  { min: 4, band: 'Critical' },
  { min: 3, band: 'High' },
  { min: 2, band: 'Medium' },
  { min: 1, band: 'Low' },
  { min: 0, band: 'Informational' },
];

// Component keywords. The first component whose keywords appear most often
// in the report wins. Edit this table to match your product's components.
// `team` is the owning team used when Teamwork Graph is unavailable.
export const COMPONENT_KEYWORDS = {
  login: { keywords: ['login', 'sign in', 'sign-in', 'sign-in', 'authentication', 'password reset', 'forgot password', 'session'], team: 'Identity' },
  checkout: { keywords: ['checkout', 'payment', 'cart', 'billing', 'invoice', 'refund'], team: 'Payments' },
  admin: { keywords: ['admin panel', 'admin console', 'admin dashboard', 'administration'], team: 'Platform' },
  api: { keywords: ['api', 'rest endpoint', 'graphql', '/api/'], team: 'Platform' },
  search: { keywords: ['search', 'filter', 'query'], team: 'Search' },
  upload: { keywords: ['upload', 'file upload', 'avatar', 'attachment'], team: 'Media' },
  user: { keywords: ['user profile', 'account settings', 'profile page'], team: 'Identity' },
};

// Component -> owning team. Used by routeOwner when Teamwork Graph is not
// available (the default). Teamwork Graph routing, when enabled, overrides this.
export const COMPONENT_TEAMS = Object.fromEntries(
  Object.entries(COMPONENT_KEYWORDS).map(([component, { team }]) => [component, team]),
);

// Missing-evidence checklist. `check` is implemented in triage.js; each item
// documents what is missing, why it matters, and whether it blocks escalation.
// `blocksEscalation` may be 'always', 'never', or 'high-only' (only blocks
// when the severity band is High or Critical).
export const EVIDENCE_CHECKLIST = [
  { id: 'affected-version', label: 'Affected version / build', why: 'Without a version the team cannot tell whether the report is already fixed or still present.', blocksEscalation: 'always' },
  { id: 'repro-steps', label: 'Numbered reproduction steps', why: 'Two or more ordered steps are the minimum for anyone else to reproduce the issue.', blocksEscalation: 'always' },
  { id: 'poc', label: 'Proof of concept (request/response, curl, or screenshot)', why: 'A PoC turns a claim into something the team can replay. Required before a High/Critical report escalates.', blocksEscalation: 'high-only' },
  { id: 'impact-demo', label: 'Demonstrated impact (what data or action was actually reached)', why: 'The claimed impact class must be backed by what the reporter actually reached, not what they assume is reachable.', blocksEscalation: 'high-only' },
  { id: 'account-role', label: 'Account role used during testing', why: 'Access-control reports are meaningless without knowing which role the reporter acted as.', blocksEscalation: 'high-only', onlyFor: ['idor', 'privilege-escalation', 'auth-bypass'] },
  { id: 'expected-vs-actual', label: 'Expected vs actual behaviour', why: 'One line each makes the bug unambiguous for the fixer.', blocksEscalation: 'never' },
  { id: 'environment', label: 'Environment (browser/app, OS)', why: 'Helps reproduce client-side issues; not a blocker.', blocksEscalation: 'never' },
];

// Escalation policy.
export const ESCALATION = {
  minBandForEscalation: 'Medium',
  minConfidenceForEscalation: 'Medium',
};
