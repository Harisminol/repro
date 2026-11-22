// index.jsx — Repro triage issue panel (UI Kit 2).
// Read-only: shows the triage result for the current issue. The agent's
// verdict is advisory; a human confirms before any transition or assignment.

import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Box, Heading, SectionMessage, Stack, Text, useProductContext } from '@forge/react';
import { invoke } from '@forge/bridge';

const BAND_TONE = { Critical: 'danger', High: 'danger', Medium: 'warning', Low: 'information', Informational: 'information' };

function App() {
  const context = useProductContext();
  const issueKey = context?.extension?.issue?.key;
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!issueKey) return;
    invoke('getTriage', { issueKey })
      .then(setResult)
      .catch((err) => setError(err?.message || String(err)));
  }, [issueKey]);

  if (!issueKey) {
    return <Text>Open this panel on a Jira issue to see its Repro triage.</Text>;
  }
  if (error) {
    return <SectionMessage title="Triage unavailable" appearance="error"><Text>{error}</Text></SectionMessage>;
  }
  if (!result) {
    return <Text>Running triage on {issueKey}…</Text>;
  }

  return (
    <Stack space="space.200">
      <Heading as="h3">Repro triage — {result.issueKey}</Heading>
      <SectionMessage title={`${result.band} · ${result.confidence} confidence`} appearance={BAND_TONE[result.band] || 'information'}>
        <Text>{result.summaryLine}</Text>
      </SectionMessage>
      <Text>Score: {result.total}/4 (exploitability + impact). Recommendation: {result.recommendation}.</Text>
      <Box>
        <Heading as="h4">Severity factors (each cites the report text)</Heading>
        {result.factors.map((f) => (
          <Text key={f.id}>• {f.label}: {f.score}/{f.max} — {f.evidence}</Text>
        ))}
      </Box>
      <Box>
        <Heading as="h4">Missing reproduction evidence</Heading>
        {result.missing.length === 0 ? (
          <Text>None — the report has everything needed to escalate.</Text>
        ) : (
          result.missing.map((m) => (
            <Text key={m.id}>☐ {m.label}{m.blocksEscalation ? ' (blocks escalation)' : ''} — {m.why}</Text>
          ))
        )}
      </Box>
      <Box>
        <Heading as="h4">Possible duplicates</Heading>
        {result.duplicates.length === 0 ? (
          <Text>No matching known issue found.</Text>
        ) : (
          result.duplicates.map((d) => (
            <Text key={d.key}>• {d.key} — {d.summary} ({d.verdict}, score {d.score})</Text>
          ))
        )}
      </Box>
      <Box>
        <Heading as="h4">Teamwork Graph — reporter history</Heading>
        {result.graph?.available ? (
          result.graph.items.length === 0 ? (
            <Text>No other reports by {result.graph.reporterName || 'this reporter'}.</Text>
          ) : (
            result.graph.items.map((it) => (
              <Text key={it.id || it.key || it.title}>• {it.key ? `${it.key}: ` : ''}{it.title}{it.status ? ` (${it.status})` : ''}</Text>
            ))
          )
        ) : (
          <Text>Teamwork Graph context unavailable ({result.graph?.error || 'unknown reason'}).</Text>
        )}
      </Box>
      <Text>
        Routing: {result.routing.team ? `owning team ${result.routing.team}` : 'no owning team yet'} ({result.routing.source}).
      </Text>
      <Text>Repro is read-only. A human confirms before any transition or assignment.</Text>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
