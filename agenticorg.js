// AgenticOrg: start one of our agents. Mirrors the official SDK's agents.run()
// (POST /api/v1/agents/{uuid}/run with a Bearer ao_sk_ key).
// Run status is one of completed | failed | hitl_triggered | budget_exceeded.
const BASE = (process.env.AGENTICORG_BASE_URL || 'https://agenticorg.hackathon.pinelabs.com').replace(/\/$/, '');

// Which env var holds each agent's UUID.
const AGENTS = {
  shopper: 'AGENTICORG_SHOPPER_AGENT_ID',
  demand: 'AGENTICORG_DEMAND_AGENT_ID',
  coach: 'AGENTICORG_COACH_AGENT_ID',
};

export const isConfigured = (agent) =>
  Boolean(process.env.AGENTICORG_API_KEY && process.env[AGENTS[agent]]);

export async function runAgent(agent, inputs) {
  const res = await fetch(`${BASE}/api/v1/agents/${process.env[AGENTS[agent]]}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AGENTICORG_API_KEY}` },
    body: JSON.stringify({ action: 'process', inputs, context: {} }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AgenticOrg run failed (${res.status}): ${JSON.stringify(data)}`);
  return { runId: data.run_id ?? data.task_id ?? data.id, status: data.status, confidence: data.confidence, output: data.output, raw: data };
}

// Agents without tools answer in JSON. Accept an object, or the first {...} block inside text
// (models sometimes wrap it in prose or ```json fences). Returns null if there is none.
export function outputJson(output) {
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string' || typeof output.answer === 'string') return outputJson(output.text || output.answer) || output;
    return output;
  }
  const text = String(output || '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Agent output may be text or JSON; reduce it to something we can show a user.
export function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  return output.summary || output.answer || output.text || output.message || JSON.stringify(output);
}
