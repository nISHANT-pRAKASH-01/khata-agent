import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as pinelabs from './pinelabs.js';
import * as agenticorg from './agenticorg.js';

const DATA_FILE = process.env.DATA_FILE || 'data.json';
const db = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { shops: [], entries: [], reminders: [], logs: [] };
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const id = () => crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

// Every action is logged with a timestamp — this is the "proof of life" for judges.
function log(actor, action, details) {
  db.logs.push({ at: now(), actor, action, details });
  save();
}

function balances(shopId) {
  const map = {};
  for (const e of db.entries.filter((e) => e.shopId === shopId)) {
    const key = e.customerPhone;
    map[key] ??= { customerName: e.customerName, customerPhone: e.customerPhone, balance: 0, lastEntryAt: e.at };
    map[key].balance += e.type === 'credit' ? e.amount : -e.amount;
    map[key].lastEntryAt = e.at;
  }
  return Object.values(map);
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---- Shopkeeper (web app) ----
app.post('/api/signup', (req, res) => {
  const { ownerName, shopName, phone } = req.body;
  if (!ownerName || !shopName || !phone) return res.status(400).json({ error: 'All fields required' });
  const shop = { id: id(), ownerName, shopName, phone, at: now() };
  db.shops.push(shop);
  log('shopkeeper', 'signup', { shopId: shop.id, shopName, ownerName });
  res.json(shop);
});

app.get('/api/shops/:shopId', (req, res) => {
  const shop = db.shops.find((s) => s.id === req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  res.json({
    shop,
    balances: balances(shop.id),
    entries: db.entries.filter((e) => e.shopId === shop.id).slice(-50).reverse(),
    reminders: db.reminders.filter((r) => r.shopId === shop.id).reverse(),
  });
});

app.post('/api/shops/:shopId/entries', (req, res) => {
  const { customerName, customerPhone, amount, type, note } = req.body;
  if (!customerName || !customerPhone || !(amount > 0) || !['credit', 'payment'].includes(type)) {
    return res.status(400).json({ error: 'customerName, customerPhone, amount > 0, type credit|payment required' });
  }
  const entry = { id: id(), shopId: req.params.shopId, customerName, customerPhone, amount: Number(amount), type, note, at: now() };
  db.entries.push(entry);
  log('shopkeeper', `khata_${type}`, entry);
  res.json(entry);
});

// Shopkeeper asks the AgenticOrg agent to check dues now; it drafts via our /mcp tools.
app.post('/api/shops/:shopId/run-agent', async (req, res) => {
  const shop = db.shops.find((s) => s.id === req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (!agenticorg.isConfigured()) return res.status(503).json({ error: 'AgenticOrg agent not connected yet' });
  log('shopkeeper', 'asked_agent', { shopId: shop.id });
  try {
    const run = await agenticorg.runAgent({ shopId: shop.id, shopName: shop.shopName, task: 'Check dues for this shop and draft reminders' });
    log('agent', 'agenticorg_run', { shopId: shop.id, runId: run.runId, status: run.status });
    res.json(run);
  } catch (err) {
    log('agent', 'agenticorg_run_failed', { shopId: shop.id, error: err.message });
    res.status(502).json({ error: err.message });
  }
});

// Human-in-the-loop: the shopkeeper approves or rejects what the agent drafted.
app.post('/api/reminders/:id/approve', async (req, res) => {
  const r = db.reminders.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Reminder not pending' });
  const shop = db.shops.find((s) => s.id === r.shopId);
  if (req.body.message) r.message = req.body.message; // shopkeeper may edit before approving
  try {
    if (!pinelabs.isConfigured()) throw new Error('Pine Labs keys not set in .env');
    const link = await pinelabs.createPaymentLink({
      amountRupees: r.amount,
      description: `Khata dues at ${shop.shopName}`,
      reference: r.id,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
    });
    r.paymentLink = link.url;
    r.paymentLinkId = link.id;
  } catch (err) {
    log('system', 'payment_link_error', { reminderId: r.id, error: err.message });
    return res.status(502).json({ error: err.message });
  }
  r.status = 'approved';
  r.approvedAt = now();
  log('shopkeeper', 'approved_reminder', { reminderId: r.id, amount: r.amount, paymentLink: r.paymentLink });
  res.json(r);
});

app.post('/api/reminders/:id/reject', (req, res) => {
  const r = db.reminders.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Reminder not pending' });
  r.status = 'rejected';
  log('shopkeeper', 'rejected_reminder', { reminderId: r.id, reason: req.body.reason });
  res.json(r);
});

app.post('/api/reminders/:id/mark-paid', (req, res) => {
  const r = db.reminders.find((x) => x.id === req.params.id);
  if (!r || r.status !== 'approved') return res.status(400).json({ error: 'Reminder not approved' });
  r.status = 'paid';
  db.entries.push({ id: id(), shopId: r.shopId, customerName: r.customerName, customerPhone: r.customerPhone, amount: r.amount, type: 'payment', note: `Paid via Pine Labs link ${r.paymentLinkId || ''}`, at: now() });
  log('shopkeeper', 'payment_received', { reminderId: r.id, amount: r.amount });
  res.json(r);
});

// Pine Labs webhook — point the dashboard's webhook URL at /api/pinelabs/webhook.
app.post('/api/pinelabs/webhook', (req, res) => {
  log('pinelabs', 'webhook', req.body);
  res.sendStatus(200);
});

// ---- Agent tools (used by the AgenticOrg agent over MCP, or REST with x-api-key) ----
function getDues() {
  const result = db.shops.map((shop) => ({
    shopId: shop.id,
    shopName: shop.shopName,
    ownerName: shop.ownerName,
    dues: balances(shop.id).filter((b) => b.balance > 0),
  })).filter((s) => s.dues.length);
  log('agent', 'read_dues', { shops: result.length });
  return result;
}

function draftReminder({ shopId, customerPhone, message }) {
  const due = db.shops.some((s) => s.id === shopId) && balances(shopId).find((b) => b.customerPhone === customerPhone);
  if (!due || due.balance <= 0) throw new Error('No dues for that shop/customer');
  if (!message) throw new Error('message required');
  const r = { id: id(), shopId, customerName: due.customerName, customerPhone, amount: due.balance, message, status: 'pending', at: now() };
  db.reminders.push(r);
  log('agent', 'drafted_reminder', { reminderId: r.id, shopId, amount: r.amount, message });
  return { ...r, note: 'Draft only. Waiting for shopkeeper approval; nothing was sent.' };
}

const agentAuth = (req, res, next) =>
  req.get('x-api-key') === process.env.AGENT_API_KEY ||
  req.get('authorization') === `Bearer ${process.env.AGENT_API_KEY}`
    ? next()
    : res.status(401).json({ error: 'Bad API key' });

app.get('/api/agent/dues', agentAuth, (req, res) => res.json(getDues()));

app.post('/api/agent/reminders', agentAuth, (req, res) => {
  try { res.json(draftReminder(req.body)); } catch (err) { res.status(400).json({ error: err.message }); }
});

// Remote MCP (Streamable HTTP, stateless) — register in AgenticOrg under Connectors > Remote MCP.
function buildMcpServer() {
  const server = new McpServer({ name: 'khata-agent', version: '1.0.0' });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  server.registerTool('get_dues', {
    description: 'List every kirana shop with customers who owe money on khata (udhaar): shopId, shop/owner name, customer name, phone and balance in rupees.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => asText(getDues()));
  server.registerTool('draft_reminder', {
    description: 'Save a polite payment-reminder DRAFT for one customer, written in the shopkeeper\'s name. Does not send anything: the shopkeeper must approve it in the Khata Agent app, which then creates a Pine Labs payment link.',
    inputSchema: {
      shopId: z.string().describe('shopId from get_dues'),
      customerPhone: z.string().describe('customerPhone from get_dues'),
      message: z.string().describe('Short reminder text in Hinglish, signed with the shop name'),
    },
  }, async (args) => {
    try { return asText(draftReminder(args)); } catch (err) { return { ...asText({ error: err.message }), isError: true }; }
  });
  return server;
}

app.post('/mcp', agentAuth, async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all('/mcp', (req, res) => res.status(405).json({ error: 'Use POST' }));

app.get('/api/logs', (req, res) => res.json(db.logs.slice().reverse()));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Khata Agent on http://localhost:${port}`));
