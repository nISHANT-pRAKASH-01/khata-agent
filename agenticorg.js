// AgenticOrg: start our "Khata Munshi" agent run. Mirrors the official SDK's agents.run()
// (POST /api/v1/agents/{agentId}/run with a Bearer ao_sk_ key).
const BASE = (process.env.AGENTICORG_BASE_URL || 'https://agenticorg.hackathon.pinelabs.com').replace(/\/$/, '');

export const isConfigured = () =>
  Boolean(process.env.AGENTICORG_API_KEY && process.env.AGENTICORG_AGENT_ID);

export async function runAgent(inputs) {
  const res = await fetch(`${BASE}/api/v1/agents/${process.env.AGENTICORG_AGENT_ID}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AGENTICORG_API_KEY}` },
    body: JSON.stringify({ action: 'process', inputs, context: {} }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AgenticOrg run failed (${res.status}): ${JSON.stringify(data)}`);
  return { runId: data.run_id ?? data.task_id ?? data.id, status: data.status, output: data.output, raw: data };
}
