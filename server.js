import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as pinelabs from './pinelabs.js';

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

// ---- Agent API (called by the AgenticOrg agent; needs x-api-key) ----
const agentAuth = (req, res, next) =>
  req.get('x-api-key') === process.env.AGENT_API_KEY ? next() : res.status(401).json({ error: 'Bad API key' });

app.get('/api/agent/dues', agentAuth, (req, res) => {
  const result = db.shops.map((shop) => ({
    shopId: shop.id,
    shopName: shop.shopName,
    ownerName: shop.ownerName,
    dues: balances(shop.id).filter((b) => b.balance > 0),
  })).filter((s) => s.dues.length);
  log('agent', 'read_dues', { shops: result.length });
  res.json(result);
});

app.post('/api/agent/reminders', agentAuth, (req, res) => {
  const { shopId, customerPhone, message } = req.body;
  const due = db.shops.some((s) => s.id === shopId) && balances(shopId).find((b) => b.customerPhone === customerPhone);
  if (!due || due.balance <= 0) return res.status(400).json({ error: 'No dues for that shop/customer' });
  if (!message) return res.status(400).json({ error: 'message required' });
  const r = { id: id(), shopId, customerName: due.customerName, customerPhone, amount: due.balance, message, status: 'pending', at: now() };
  db.reminders.push(r);
  log('agent', 'drafted_reminder', { reminderId: r.id, shopId, amount: r.amount, message });
  res.json({ ...r, note: 'Waiting for shopkeeper approval' });
});

app.get('/api/logs', (req, res) => res.json(db.logs.slice().reverse()));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Khata Agent on http://localhost:${port}`));
