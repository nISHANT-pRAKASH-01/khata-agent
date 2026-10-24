import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as pinelabs from './pinelabs.js';
import * as agenticorg from './agenticorg.js';
import * as mailer from './mailer.js';
import { seed, AREA_CENTERS } from './seed.js';

const DAY = 86400000;
const IST = 5.5 * 3600000;
const PLANS = { day: { price: 100, label: 'Day pass' }, premium: { price: 5000, label: 'Premium (30 days)' } };

const id = () => crypto.randomUUID().slice(0, 8);
const token = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const istDay = (t) => new Date(new Date(t).getTime() + IST).toISOString().slice(0, 10);
const istMidnight = (t) => Date.parse(`${istDay(t)}T00:00:00Z`) - IST;
const istHour = (t) => new Date(new Date(t).getTime() + IST).getUTCHours();
const endOfDayIST = (d) => new Date(istMidnight(d) + DAY - 1);

const DATA_FILE = process.env.DATA_FILE || 'data.json';
const db = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : seed({ id, endOfDayIST, istMidnight });
// Older data files (khata-only) predate the marketplace: add the mock marketplace alongside.
if (!db.products) {
  const fresh = seed({ id, endOfDayIST, istMidnight });
  for (const k of Object.keys(fresh)) db[k] = [...(db[k] || []), ...fresh[k]];
}
for (const k of ['assists', 'stockAdvice']) db[k] ??= [];
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
save();

// Every real action is logged with a timestamp — this is the "proof of life" for judges.
function log(actor, action, details) {
  db.logs.push({ at: now(), actor, action, details });
  save();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const planActive = (shop) => Boolean(shop.plan && new Date(shop.plan.validUntil) > new Date());
const isPremium = (shop) => planActive(shop) && shop.plan.type === 'premium';
const publicShop = (s) => ({
  id: s.id, shopName: s.shopName, ownerName: s.ownerName, area: s.area, category: s.category, lat: s.lat, lng: s.lng,
  premium: isPremium(s), delivery: isPremium(s), open: planActive(s),
});
const privateShop = (s) => ({ ...publicShop(s), phone: s.phone, email: s.email, plan: s.plan, planActive: planActive(s) });
const shopOf = (o) => db.shops.find((s) => s.id === o.shopId);
const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

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

function addKhata(shopId, { customerName, customerPhone, amount, type, note }) {
  const entry = { id: id(), shopId, customerName, customerPhone, amount: Number(amount), type, note, at: now() };
  db.entries.push(entry);
  log('shopkeeper', `khata_${type}`, entry);
  return entry;
}

// ---- Email (fire-and-forget; never blocks or fails an order) ----
function notify(to, subject, text) {
  if (!to) return;
  if (!mailer.isConfigured()) return log('system', 'email_skipped', { subject, reason: 'Gmail not configured' });
  mailer.sendMail({ to, subject, text })
    .then(() => log('system', 'email_sent', { subject }))
    .catch((err) => log('system', 'email_failed', { subject, error: err.message }));
}

const itemsText = (o) => o.items.map((l) => `  • ${l.name} × ${l.qty} = ₹${l.price * l.qty}`).join('\n') + `\n  Total: ₹${o.total}`;

function emailForStatus(o, base) {
  const shop = shopOf(o);
  const ordersUrl = `${base}/customer.html?orders=1`;
  const msg = {
    placed: [`Order sent to ${shop.shopName}`, `We've sent your order to ${shop.shopName}. You'll get an email as soon as they confirm it.\n\n${itemsText(o)}\n\nTrack it: ${ordersUrl}`],
    confirmed: [`${shop.shopName} confirmed your order`, `Good news! ${shop.shopName} confirmed your order and is packing it.${o.paymentMethod === 'online' ? `\n\nPlease pay ₹${o.total} here: ${base}/pay.html?id=${o.paymentId}` : ''}\n\n${ordersUrl}`],
    packed: [`Your order is packed 📦`, o.fulfilment === 'delivery'
      ? `Your order from ${shop.shopName} is packed and will leave with a delivery partner shortly.\n\n${ordersUrl}`
      : `Your order from ${shop.shopName} is packed and ready. Walk in and collect it at ${shop.shopName}, ${shop.area}.\n\n${ordersUrl}`],
    out_for_delivery: [`Your order is on the way 🛵`, `${o.rider?.name || 'Your delivery partner'} is on the way with your order from ${shop.shopName}. Watch them live on the map: ${base}/customer.html?track=${o.id}`],
    completed: [`Thanks for shopping at ${shop.shopName}`, `Your order is complete. See you again!\n\n${ordersUrl}`],
    cancelled: [`Your order was cancelled`, `Your order from ${shop.shopName} was cancelled. Nothing was charged for it.\n\n${ordersUrl}`],
  }[o.status];
  if (msg) notify(o.customerEmail, msg[0], msg[1]);
  if (o.status === 'placed') {
    notify(shop.email, `New order from ${o.customerName}: please confirm`, `${o.customerName} (${o.customerPhone}) placed a ${o.fulfilment} order.\n\n${itemsText(o)}\n\nPayment: ${o.paymentMethod.replace(/_/g, ' ')}\n\nConfirm it here: ${base}/owner.html`);
  }
}

// ---- Inventory ----
// Turns [{productId, qty}] into priced lines, checking the shop actually has the stock.
function priceLines(shopId, items) {
  if (!Array.isArray(items) || !items.length) fail(400, 'Add at least one item');
  const qtyById = {};
  for (const it of items) {
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100) fail(400, 'Quantity must be 1–100');
    qtyById[it.productId] = (qtyById[it.productId] || 0) + qty;
  }
  return Object.entries(qtyById).map(([productId, qty]) => {
    const p = db.products.find((x) => x.id === productId && x.shopId === shopId);
    if (!p) fail(400, 'Item not found in this shop');
    if (p.stock < qty) fail(409, `Only ${p.stock} left of ${p.name}`);
    return { productId, name: p.name, price: p.price, qty };
  });
}

// Idempotent: a given (reason, refId, product) stock move is applied at most once,
// so a retried order, cancel or bill can never change stock twice.
function moveStock(shopId, lines, sign, reason, refId) {
  for (const l of lines) {
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    if (refId && db.stockMoves.some((m) => m.refId === refId && m.reason === reason && m.productId === p.id)) continue;
    p.stock += sign * l.qty;
    db.stockMoves.push({ id: id(), shopId, productId: p.id, delta: sign * l.qty, reason, refId, at: now() });
  }
}

const validKey = (k) => typeof k === 'string' && /^[\w-]{8,64}$/.test(k);

// ---- Payments: Pine Labs link when keys are set, otherwise our UPI QR page ----
async function createPayment({ kind, refId, shopId, amount, description, customerName, customerPhone }) {
  const p = { id: id(), kind, refId, shopId, amount, description, status: 'pending', at: now() };
  if (pinelabs.isConfigured()) {
    try {
      const link = await pinelabs.createPaymentLink({ amountRupees: amount, description, reference: p.id, customerName, customerPhone });
      Object.assign(p, { provider: 'pinelabs', link: link.url, providerId: link.id });
    } catch (err) {
      log('system', 'payment_link_error', { kind, refId, error: err.message });
      fail(502, err.message);
    }
  } else {
    Object.assign(p, { provider: 'upi_qr', link: `/pay.html?id=${p.id}` });
  }
  db.payments.push(p);
  log('system', 'payment_link_created', { paymentId: p.id, kind, refId, amount, provider: p.provider });
  return p;
}

function activatePlan(shop, type) {
  const base = isPremium(shop) ? new Date(shop.plan.validUntil) : new Date();
  shop.plan = type === 'premium'
    ? { type, validUntil: new Date(base.getTime() + 30 * DAY).toISOString() }
    : { type, validUntil: endOfDayIST(new Date()).toISOString() };
  log('shopkeeper', 'plan_activated', { shopId: shop.id, plan: shop.plan });
}

function markPaid(p, source) {
  if (p.status === 'paid') return;
  p.status = 'paid';
  p.paidAt = now();
  log(source, 'payment_received', { paymentId: p.id, kind: p.kind, refId: p.refId, amount: p.amount, utr: p.utr });
  if (p.kind === 'order') {
    const o = db.orders.find((x) => x.id === p.refId);
    if (o) o.paymentStatus = 'paid';
  } else if (p.kind === 'plan') {
    const shop = db.shops.find((s) => s.id === p.shopId);
    if (shop && !p.planActivated) { p.planActivated = true; activatePlan(shop, p.refId); }
  } else if (p.kind === 'khata') {
    const r = db.reminders.find((x) => x.id === p.refId);
    if (r && r.status === 'approved') settleReminder(r, `Paid via ${p.provider} ${p.utr ? 'UTR ' + p.utr : p.providerId || p.id}`);
  }
  save();
}

// Payer says "I've paid" on the QR page. Plans go live straight away (UTR kept for checking);
// orders and khata wait for the shopkeeper to confirm the money arrived.
function claimPaid(p, utr) {
  if (p.status !== 'pending') return;
  p.status = 'claimed';
  p.utr = utr;
  p.claimedAt = now();
  log('payer', 'payment_claimed', { paymentId: p.id, kind: p.kind, refId: p.refId, amount: p.amount, utr });
  if (p.kind === 'order') {
    const o = db.orders.find((x) => x.id === p.refId);
    if (o) o.paymentStatus = 'claimed';
  } else if (p.kind === 'plan') {
    const shop = db.shops.find((s) => s.id === p.shopId);
    if (shop && !p.planActivated) { p.planActivated = true; activatePlan(shop, p.refId); }
  }
  save();
}

function settleReminder(r, note) {
  r.status = 'paid';
  addKhata(r.shopId, { customerName: r.customerName, customerPhone: r.customerPhone, amount: r.amount, type: 'payment', note });
}

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static('public'));
const baseUrl = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

app.get('/api/config', (req, res) => res.json({
  paymentsLive: pinelabs.isConfigured(), emailOn: mailer.isConfigured(),
  googleClientId: process.env.GOOGLE_CLIENT_ID || null, plans: PLANS, areas: AREA_CENTERS,
}));

// ---- Sign in with Google (both sides) ----
// Without GOOGLE_CLIENT_ID the app runs in demo mode: any email is accepted, clearly labelled in the UI.
async function verifyGoogle({ credential, demoEmail, demoName }) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(demoEmail || '')) fail(400, 'Enter a valid email');
    return { email: demoEmail.toLowerCase(), name: demoName || demoEmail.split('@')[0] };
  }
  if (!credential) fail(400, 'Google sign-in missing');
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== process.env.GOOGLE_CLIENT_ID || t.email_verified !== 'true') fail(401, 'Google sign-in failed');
  return { email: t.email.toLowerCase(), name: t.name || t.email.split('@')[0], picture: t.picture };
}

const pendingOwners = new Map(); // signup ticket -> verified Google profile, until the shop is registered

app.post('/api/auth/google', async (req, res) => {
  const g = await verifyGoogle(req.body);
  if (req.body.role === 'owner') {
    const shop = db.shops.find((s) => s.email === g.email);
    if (!shop) {
      const ticket = token();
      pendingOwners.set(ticket, g);
      return res.json({ needsShop: true, ticket, name: g.name, email: g.email });
    }
    shop.token ??= token();
    save();
    return res.json({ shop: privateShop(shop), token: shop.token });
  }
  let c = db.customers.find((x) => x.email === g.email);
  if (!c) {
    c = { id: id(), name: g.name, email: g.email, at: now() };
    db.customers.push(c);
    log('customer', 'signup', { customerId: c.id, name: g.name });
  }
  c.token ??= token();
  save();
  res.json({ customer: customerView(c), token: c.token });
});

// ---- Customer side ----
const customerView = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, area: c.area, profileDone: Boolean(c.phone && c.area) });
const customerAuth = (req, res, next) => {
  req.customer = db.customers.find((c) => c.token && c.token === req.get('x-customer-token'));
  req.customer ? next() : res.status(401).json({ error: 'Please log in again' });
};

app.patch('/api/customers/me', customerAuth, (req, res) => {
  const { name, phone, area } = req.body;
  if (!/^\d{10}$/.test(phone || '')) fail(400, 'Enter a 10-digit phone number');
  if (!area) fail(400, 'Choose your area');
  Object.assign(req.customer, { phone, area, name: name || req.customer.name });
  save();
  res.json(customerView(req.customer));
});

app.get('/api/areas', (req, res) => res.json([...new Set([...Object.keys(AREA_CENTERS), ...db.shops.map((s) => s.area)].filter(Boolean))].sort()));

// Premium shops are "featured" in every area; day-pass shops show only in their own area.
app.get('/api/market/shops', (req, res) => {
  const { area, q } = req.query;
  const needle = (q || '').toLowerCase();
  const shops = db.shops.filter(planActive)
    .filter((s) => !area || s.area === area || isPremium(s))
    .filter((s) => !needle || s.shopName.toLowerCase().includes(needle) ||
      db.products.some((p) => p.shopId === s.id && p.name.toLowerCase().includes(needle)))
    .map((s) => ({ ...publicShop(s), items: db.products.filter((p) => p.shopId === s.id && p.stock > 0).length }))
    .sort((a, b) => (b.premium - a.premium) || ((b.area === area) - (a.area === area)));
  res.json(shops);
});

app.get('/api/market/shops/:id', (req, res) => {
  const shop = db.shops.find((s) => s.id === req.params.id);
  if (!shop || !planActive(shop)) fail(404, 'This shop is not taking orders today');
  db.views.push({ shopId: shop.id, at: now() });
  save();
  res.json({
    shop: publicShop(shop),
    products: db.products.filter((p) => p.shopId === shop.id)
      .map(({ id, name, category, unit, price, stock }) => ({ id, name, category, unit, price, inStock: stock > 0, left: stock <= 5 ? stock : null })),
  });
});

// Placing an order reserves the stock straight away (so two people can't buy the last packet);
// the shop then confirms or rejects it. The client sends an idempotency key per checkout, so
// double-taps and network retries return the same order instead of reserving stock twice.
app.post('/api/orders', customerAuth, (req, res) => {
  const { shopId, items, fulfilment, address, location, paymentMethod, idempotencyKey } = req.body;
  const c = req.customer;
  if (!validKey(idempotencyKey)) fail(400, 'Missing idempotency key');
  const existing = db.orders.find((o) => o.customerId === c.id && o.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ order: existing, duplicate: true });

  if (!c.phone) fail(400, 'Add your phone number first');
  const shop = db.shops.find((s) => s.id === shopId);
  if (!shop || !planActive(shop)) fail(400, 'This shop is not taking orders today');
  if (!['pickup', 'delivery'].includes(fulfilment)) fail(400, 'Choose pickup or delivery');
  if (fulfilment === 'delivery' && !isPremium(shop)) fail(400, 'This shop offers pickup only');
  if (fulfilment === 'delivery' && !address) fail(400, 'Delivery address required');
  if (!['online', 'pay_at_shop', 'khata'].includes(paymentMethod)) fail(400, 'Choose a payment method');

  const lines = priceLines(shop.id, items);
  const order = {
    id: id(), idempotencyKey, shopId: shop.id, channel: 'online',
    customerId: c.id, customerName: c.name, customerPhone: c.phone, customerEmail: c.email,
    items: lines, total: lines.reduce((t, l) => t + l.price * l.qty, 0), fulfilment, address: address || null,
    location: fulfilment === 'delivery' ? (validPoint(location) ? location : AREA_CENTERS[c.area] || { lat: shop.lat, lng: shop.lng }) : null,
    paymentMethod, paymentStatus: 'pending', status: 'placed', timeline: [{ status: 'placed', at: now() }], at: now(),
  };
  moveStock(shop.id, lines, -1, 'order', order.id);
  db.orders.push(order);
  log('customer', 'order_placed', { orderId: order.id, shopId: shop.id, total: order.total, fulfilment, paymentMethod });
  emailForStatus(order, baseUrl(req));
  res.json({ order });
});

const orderForCustomer = (o) => {
  const shop = shopOf(o);
  return {
    ...o, idempotencyKey: undefined,
    shopName: shop?.shopName, shopPhone: shop?.phone, shopArea: shop?.area,
    paymentLink: o.paymentId && o.paymentStatus === 'pending' ? db.payments.find((p) => p.id === o.paymentId)?.link : undefined,
    rider: o.rider && { name: o.rider.name, phone: o.rider.phone, lat: o.rider.lat, lng: o.rider.lng, at: o.rider.at },
  };
};

app.get('/api/customers/me/orders', customerAuth, (req, res) => {
  res.json(db.orders.filter((o) => o.customerId === req.customer.id && !o.mock).reverse().map(orderForCustomer));
});

app.get('/api/orders/:id/track', customerAuth, (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.customerId === req.customer.id);
  if (!o) fail(404, 'Order not found');
  const shop = shopOf(o);
  res.json({ ...orderForCustomer(o), shopLocation: { lat: shop.lat, lng: shop.lng } });
});

app.post('/api/orders/:id/cancel', customerAuth, (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.customerId === req.customer.id);
  if (!o) fail(404, 'Order not found');
  if (o.status === 'cancelled') return res.json(o);
  if (o.status !== 'placed') fail(400, 'The shop has already confirmed this order. Call them to cancel.');
  setStatus(o, 'cancelled', 'customer', baseUrl(req));
  res.json(o);
});

// ---- Payment page (UPI QR) ----
app.get('/api/payments/:id', (req, res) => {
  const p = db.payments.find((x) => x.id === req.params.id);
  if (!p) fail(404, 'Payment not found');
  res.json({ id: p.id, amount: p.amount, description: p.description, status: p.status, provider: p.provider, kind: p.kind });
});

app.post('/api/payments/:id/claim', (req, res) => {
  const p = db.payments.find((x) => x.id === req.params.id);
  if (!p || p.provider !== 'upi_qr') fail(400, 'Not a UPI payment');
  const utr = String(req.body.utr || '').trim();
  if (!/^[A-Za-z0-9]{6,22}$/.test(utr)) fail(400, 'Enter the UPI reference / UTR number from your payment app');
  claimPaid(p, utr);
  res.json({ status: p.status });
});

// Pine Labs webhook — point the dashboard's webhook URL at /api/pinelabs/webhook.
// TODO: verify the webhook signature once we have Pine Labs' signing secret.
app.post('/api/pinelabs/webhook', (req, res) => {
  log('pinelabs', 'webhook', req.body);
  const body = JSON.stringify(req.body);
  const p = db.payments.find((x) => x.provider === 'pinelabs' && x.status === 'pending' &&
    (body.includes(`"${x.id}"`) || (x.providerId && body.includes(`"${x.providerId}"`))));
  if (p && /PROCESSED|SUCCESS|PAID|CAPTURED/i.test(body)) markPaid(p, 'pinelabs');
  res.sendStatus(200);
});

// ---- Delivery rider (opens a link on their phone; shares GPS) ----
app.get('/api/rider/:orderId', (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.orderId);
  if (!o?.rider || o.rider.key !== req.query.key) fail(403, 'Invalid rider link');
  const shop = shopOf(o);
  res.json({ status: o.status, shopName: shop.shopName, shopLocation: { lat: shop.lat, lng: shop.lng }, destination: o.location, address: o.address, customerName: o.customerName, customerPhone: o.customerPhone, items: o.items, total: o.total, paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus });
});

app.post('/api/rider/:orderId/location', (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.orderId);
  if (!o?.rider || o.rider.key !== req.body.key) fail(403, 'Invalid rider link');
  if (o.status !== 'out_for_delivery') fail(400, 'This delivery is not active');
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!validPoint({ lat, lng })) fail(400, 'Bad location');
  Object.assign(o.rider, { lat, lng, at: now() });
  save();
  res.json({ ok: true });
});

app.post('/api/rider/:orderId/delivered', (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.orderId);
  if (!o?.rider || o.rider.key !== req.body.key) fail(403, 'Invalid rider link');
  if (o.status !== 'completed') setStatus(o, 'completed', 'rider', baseUrl(req));
  res.json({ status: o.status });
});

// ---- Shop owner side ----
const ownerAuth = (req, res, next) => {
  req.shop = db.shops.find((s) => s.token && s.token === req.get('x-owner-token'));
  req.shop ? next() : res.status(401).json({ error: 'Please log in again' });
};

app.post('/api/owner/signup', (req, res) => {
  const g = pendingOwners.get(req.body.ticket);
  if (!g) fail(401, 'Please sign in with Google again');
  const { shopName, phone, area, category, location } = req.body;
  if (!shopName || !area) fail(400, 'Shop name and area are required');
  if (!/^\d{10}$/.test(phone || '')) fail(400, 'Enter a 10-digit phone number');
  if (db.shops.some((s) => s.email === g.email)) fail(409, 'This Google account already has a shop');
  const pin = validPoint(location) ? location : AREA_CENTERS[area] || AREA_CENTERS.Indiranagar;
  const shop = { id: id(), ownerName: g.name, email: g.email, shopName, phone, area, category: category || 'kirana', lat: pin.lat, lng: pin.lng, plan: null, token: token(), at: now() };
  db.shops.push(shop);
  pendingOwners.delete(req.body.ticket);
  log('shopkeeper', 'signup', { shopId: shop.id, shopName, area });
  res.json({ shop: privateShop(shop), token: shop.token });
});

// Phone + PIN only works for the seeded demo shops; real owners sign in with Google.
app.post('/api/owner/demo-login', (req, res) => {
  const shop = db.shops.find((s) => s.mock && s.phone === req.body.phone && s.pin === req.body.pin);
  if (!shop) fail(401, 'Wrong demo phone or PIN');
  shop.token ??= token();
  save();
  res.json({ shop: privateShop(shop), token: shop.token });
});

app.get('/api/owner/me', ownerAuth, (req, res) => {
  const mine = db.orders.filter((o) => o.shopId === req.shop.id);
  res.json({
    shop: privateShop(req.shop),
    toConfirm: mine.filter((o) => o.status === 'placed').length,
    openOrders: mine.filter((o) => ['placed', 'confirmed', 'packed', 'out_for_delivery'].includes(o.status)).length,
    lowStock: db.products.filter((p) => p.shopId === req.shop.id && p.stock <= p.lowStockAt).length,
  });
});

app.get('/api/owner/orders', ownerAuth, (req, res) => {
  res.json(db.orders.filter((o) => o.shopId === req.shop.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60)
    .map((o) => ({ ...o, idempotencyKey: undefined, rider: o.rider && { ...o.rider, link: `/rider.html?o=${o.id}&k=${o.rider.key}` }, utr: db.payments.find((p) => p.id === o.paymentId)?.utr })));
});

const NEXT = (o) => ({
  placed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: o.fulfilment === 'delivery' ? ['out_for_delivery', 'cancelled'] : ['completed', 'cancelled'],
  out_for_delivery: ['completed'],
}[o.status] || []);

function setStatus(o, status, actor, base) {
  if (status === 'cancelled') {
    moveStock(o.shopId, o.items, +1, 'cancel', o.id);
    if (o.paymentStatus === 'on_khata') addKhata(o.shopId, { customerName: o.customerName, customerPhone: o.customerPhone, amount: o.total, type: 'payment', note: `Order ${o.id} cancelled` });
  }
  if (status === 'completed' && o.paymentMethod === 'pay_at_shop') o.paymentStatus = 'paid';
  o.status = status;
  o.timeline = [...(o.timeline || []), { status, at: now() }];
  log(actor, `order_${status}`, { orderId: o.id });
  emailForStatus(o, base);
}

app.post('/api/owner/orders/:id/status', ownerAuth, async (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  const { status, rider } = req.body;
  if (!o) fail(404, 'Order not found');
  if (o.status === status) return res.json(o); // repeated click: nothing to do
  if (!NEXT(o).includes(status)) fail(400, `Can't move a ${o.status} order to ${status}`);
  if (status === 'confirmed') {
    // Confirming a khata order is the shopkeeper agreeing to give credit.
    if (o.paymentMethod === 'khata') {
      addKhata(o.shopId, { customerName: o.customerName, customerPhone: o.customerPhone, amount: o.total, type: 'credit', note: `Order ${o.id}` });
      o.paymentStatus = 'on_khata';
    }
    if (o.paymentMethod === 'online' && !o.paymentId) {
      const p = await createPayment({ kind: 'order', refId: o.id, shopId: o.shopId, amount: o.total, description: `Order at ${req.shop.shopName}`, customerName: o.customerName, customerPhone: o.customerPhone });
      o.paymentId = p.id;
    }
  }
  if (status === 'out_for_delivery') {
    if (!rider?.name || !/^\d{10}$/.test(rider.phone || '')) fail(400, 'Enter the delivery partner\'s name and 10-digit phone');
    o.rider = { name: rider.name, phone: rider.phone, key: token(), lat: req.shop.lat, lng: req.shop.lng, at: now() };
  }
  setStatus(o, status, 'shopkeeper', baseUrl(req));
  res.json(o);
});

app.post('/api/owner/orders/:id/payment-received', ownerAuth, (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  if (!o) fail(404, 'Order not found');
  const p = db.payments.find((x) => x.id === o.paymentId);
  if (p) markPaid(p, 'shopkeeper');
  else { o.paymentStatus = 'paid'; log('shopkeeper', 'payment_received', { orderId: o.id, amount: o.total }); }
  res.json(o);
});

// The shop's own customers and what they buy — the base the timing and demand agents build on.
function shopCustomers(shopId) {
  const map = {};
  for (const o of db.orders.filter((o) => o.shopId === shopId && o.status !== 'cancelled' && o.customerPhone)) {
    const c = map[o.customerPhone] ??= { name: o.customerName, phone: o.customerPhone, email: o.customerEmail, orders: 0, spend: 0, lastOrderAt: o.at, items: {}, hours: {} };
    c.orders++;
    c.spend += o.total;
    if (o.at > c.lastOrderAt) c.lastOrderAt = o.at;
    c.email ??= o.customerEmail;
    c.hours[istHour(o.at)] = (c.hours[istHour(o.at)] || 0) + 1;
    for (const l of o.items) c.items[l.name] = (c.items[l.name] || 0) + l.qty;
  }
  const dues = Object.fromEntries(balances(shopId).map((b) => [b.customerPhone, b.balance]));
  return Object.values(map).map(({ items, hours, ...c }) => {
    const [hour, count] = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
    return {
      ...c,
      khata: dues[c.phone] || 0,
      favourites: Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty })),
      usualHour: Number(hour),
      usualHourShare: Math.round((count / c.orders) * 100),
    };
  }).sort((a, b) => b.lastOrderAt.localeCompare(a.lastOrderAt));
}

app.get('/api/owner/customers', ownerAuth, (req, res) => res.json(shopCustomers(req.shop.id)));

app.get('/api/owner/products', ownerAuth, (req, res) => {
  res.json(db.products.filter((p) => p.shopId === req.shop.id).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)));
});

app.post('/api/owner/products', ownerAuth, (req, res) => {
  const { name, category, unit, price, stock, lowStockAt } = req.body;
  if (!name || !(Number(price) > 0) || !(Number(stock) >= 0)) fail(400, 'Name, price and opening stock are required');
  const p = { id: id(), shopId: req.shop.id, name, category: category || 'Other', unit: unit || 'pc', price: Number(price), stock: Math.floor(Number(stock)), lowStockAt: Number(lowStockAt) || 5 };
  db.products.push(p);
  db.stockMoves.push({ id: id(), shopId: p.shopId, productId: p.id, delta: p.stock, reason: 'opening', at: now() });
  log('shopkeeper', 'product_added', { productId: p.id, name, stock: p.stock });
  res.json(p);
});

app.patch('/api/owner/products/:id', ownerAuth, (req, res) => {
  const p = db.products.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  if (!p) fail(404, 'Product not found');
  if (req.body.price !== undefined) {
    if (!(Number(req.body.price) > 0)) fail(400, 'Price must be above 0');
    p.price = Number(req.body.price);
  }
  log('shopkeeper', 'product_updated', { productId: p.id, price: p.price });
  res.json(p);
});

// Restock is idempotent too: the client sends a key per click, so a retried request adds stock once.
app.post('/api/owner/products/:id/restock', ownerAuth, (req, res) => {
  const p = db.products.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  const qty = Number(req.body.qty);
  if (!p) fail(404, 'Product not found');
  if (!validKey(req.body.idempotencyKey)) fail(400, 'Missing idempotency key');
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) fail(400, 'Restock quantity must be a whole number above 0');
  const before = p.stock;
  moveStock(p.shopId, [{ productId: p.id, qty }], +1, 'restock', req.body.idempotencyKey);
  if (p.stock !== before) log('shopkeeper', 'restocked', { productId: p.id, name: p.name, qty, stock: p.stock });
  res.json(p);
});

// Walk-in billing at the counter: stock goes down immediately (once per idempotency key).
app.post('/api/owner/bills', ownerAuth, async (req, res) => {
  const { items, customerName, customerPhone, paymentMethod, idempotencyKey } = req.body;
  if (!validKey(idempotencyKey)) fail(400, 'Missing idempotency key');
  const existing = db.orders.find((o) => o.shopId === req.shop.id && o.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ bill: existing, paymentLink: db.payments.find((p) => p.id === existing.paymentId)?.link, duplicate: true });
  if (!['cash', 'online', 'khata'].includes(paymentMethod)) fail(400, 'Choose cash, UPI QR or khata');
  if (paymentMethod === 'khata' && (!customerName || !/^\d{10}$/.test(customerPhone || ''))) fail(400, 'Customer name and 10-digit phone needed for khata');
  if (customerPhone && !/^\d{10}$/.test(customerPhone)) fail(400, 'Phone must be 10 digits');
  let lines = priceLines(req.shop.id, items);
  const bill = {
    id: id(), idempotencyKey, shopId: req.shop.id, channel: 'walk_in', customerId: null, customerName: customerName || 'Walk-in', customerPhone: customerPhone || null,
    items: lines, total: lines.reduce((t, l) => t + l.price * l.qty, 0), fulfilment: 'counter',
    paymentMethod, paymentStatus: paymentMethod === 'cash' ? 'paid' : 'pending', status: 'completed', timeline: [{ status: 'completed', at: now() }], at: now(),
  };
  let payment;
  if (paymentMethod === 'online') {
    payment = await createPayment({ kind: 'order', refId: bill.id, shopId: req.shop.id, amount: bill.total, description: `Bill at ${req.shop.shopName}`, customerName, customerPhone });
    bill.paymentId = payment.id;
    lines = priceLines(req.shop.id, items); // stock may have moved while we waited on Pine Labs
  }
  if (paymentMethod === 'khata') {
    addKhata(req.shop.id, { customerName, customerPhone, amount: bill.total, type: 'credit', note: `Bill ${bill.id}` });
    bill.paymentStatus = 'on_khata';
  }
  moveStock(req.shop.id, lines, -1, 'walk_in_bill', bill.id);
  db.orders.push(bill);
  log('shopkeeper', 'walk_in_bill', { billId: bill.id, total: bill.total, paymentMethod });
  res.json({ bill, paymentLink: payment?.link });
});

app.post('/api/owner/plan', ownerAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) fail(400, 'Unknown plan');
  if (plan === 'day' && isPremium(req.shop)) fail(400, 'You are already on Premium');
  const p = await createPayment({
    kind: 'plan', refId: plan, shopId: req.shop.id, amount: PLANS[plan].price,
    description: `${PLANS[plan].label} for ${req.shop.shopName}`, customerName: req.shop.ownerName, customerPhone: req.shop.phone,
  });
  res.json({ paymentLink: p.link });
});

// Premium only: what sells, when, to whom, and how many people found the shop.
app.get('/api/owner/insights', ownerAuth, (req, res) => {
  if (!isPremium(req.shop)) fail(402, 'Insights are part of Premium');
  const shopId = req.shop.id;
  const t = Date.now();
  const orders = db.orders.filter((o) => o.shopId === shopId && o.status !== 'cancelled');
  const within = (days) => orders.filter((o) => t - Date.parse(o.at) < days * DAY);
  const revenue = (list) => list.reduce((s, o) => s + o.total, 0);
  const last30 = within(30);
  const today = istDay(t);

  const byProduct = {};
  for (const o of last30) for (const l of o.items) {
    byProduct[l.productId] ??= { name: l.name, qty: 0, revenue: 0 };
    byProduct[l.productId].qty += l.qty;
    byProduct[l.productId].revenue += l.qty * l.price;
  }
  const topProducts = Object.entries(byProduct).map(([productId, v]) => ({ productId, ...v })).sort((a, b) => b.qty - a.qty).slice(0, 8);

  const salesByDay = [];
  for (let i = 13; i >= 0; i--) {
    const day = istDay(t - i * DAY);
    salesByDay.push({ day, revenue: revenue(orders.filter((o) => istDay(o.at) === day)) });
  }
  const ordersByHour = Array.from({ length: 24 }, (_, h) => last30.filter((o) => istHour(o.at) === h).length);

  const customers = shopCustomers(shopId).filter((c) => t - Date.parse(c.lastOrderAt) < 30 * DAY);
  const products = db.products.filter((p) => p.shopId === shopId);
  const lowStock = products.filter((p) => p.stock <= p.lowStockAt).map(({ id, name, stock }) => ({ id, name, stock }));
  const views30 = db.views.filter((v) => v.shopId === shopId && t - Date.parse(v.at) < 30 * DAY).length;
  const online30 = last30.filter((o) => o.channel === 'online').length;

  res.json({
    revenue: { today: revenue(orders.filter((o) => istDay(o.at) === today)), d7: revenue(within(7)), d30: revenue(last30) },
    orders30: last30.length,
    channels: { online: online30, walkIn: last30.length - online30 },
    topProducts,
    salesByDay,
    ordersByHour,
    topCustomers: [...customers].sort((a, b) => b.spend - a.spend).slice(0, 5),
    repeatCustomers: customers.filter((c) => c.orders > 1).length,
    reach: { views30, conversion: views30 ? Math.round((online30 / views30) * 100) : 0 },
    lowStock,
    restockFirst: topProducts.filter((tp) => lowStock.some((l) => l.id === tp.productId)).map((tp) => tp.name),
  });
});

// ---- Khata (udhaar) ----
app.get('/api/owner/khata', ownerAuth, (req, res) => {
  const shopId = req.shop.id;
  res.json({
    balances: balances(shopId).filter((b) => b.balance !== 0),
    entries: db.entries.filter((e) => e.shopId === shopId).slice(-50).reverse(),
    reminders: db.reminders.filter((r) => r.shopId === shopId).reverse().map((r) => ({
      ...r, paymentLink: db.payments.find((p) => p.id === r.paymentId)?.link,
    })),
  });
});

app.post('/api/owner/khata/entries', ownerAuth, (req, res) => {
  const { customerName, customerPhone, amount, type, note } = req.body;
  if (!customerName || !customerPhone || !(amount > 0) || !['credit', 'payment'].includes(type)) {
    fail(400, 'customerName, customerPhone, amount > 0, type credit|payment required');
  }
  res.json(addKhata(req.shop.id, { customerName, customerPhone, amount, type, note }));
});

// Shopkeeper asks the AgenticOrg agent to check dues now; it drafts via our /mcp tools.
app.post('/api/owner/run-agent', ownerAuth, async (req, res) => {
  const shop = req.shop;
  if (!agenticorg.isConfigured('khata')) fail(503, 'AgenticOrg agent not connected yet');
  log('shopkeeper', 'asked_agent', { shopId: shop.id });
  try {
    const run = await agenticorg.runAgent('khata', { shopId: shop.id, shopName: shop.shopName, task: `Check dues for shop ${shop.id} (${shop.shopName}) and draft reminders` });
    log('agent', 'agenticorg_run', { agent: 'khata', shopId: shop.id, runId: run.runId, status: run.status });
    res.json({ status: run.status, summary: agenticorg.outputText(run.output) });
  } catch (err) {
    log('agent', 'agenticorg_run_failed', { shopId: shop.id, error: err.message });
    fail(502, err.message);
  }
});

const ownReminder = (req, status) => {
  const r = db.reminders.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  if (!r || r.status !== status) fail(400, `Reminder not ${status}`);
  return r;
};

// Human-in-the-loop: the shopkeeper approves or rejects what the agent drafted.
app.post('/api/owner/reminders/:id/approve', ownerAuth, async (req, res) => {
  const r = ownReminder(req, 'pending');
  if (req.body.message) r.message = req.body.message; // shopkeeper may edit before approving
  const p = await createPayment({
    kind: 'khata', refId: r.id, shopId: r.shopId, amount: r.amount, description: `Khata dues at ${req.shop.shopName}`,
    customerName: r.customerName, customerPhone: r.customerPhone,
  });
  r.paymentId = p.id;
  r.status = 'approved';
  r.approvedAt = now();
  log('shopkeeper', 'approved_reminder', { reminderId: r.id, amount: r.amount, paymentLink: p.link });
  res.json({ ...r, paymentLink: p.link });
});

app.post('/api/owner/reminders/:id/reject', ownerAuth, (req, res) => {
  const r = ownReminder(req, 'pending');
  r.status = 'rejected';
  log('shopkeeper', 'rejected_reminder', { reminderId: r.id, reason: req.body.reason });
  res.json(r);
});

app.post('/api/owner/reminders/:id/mark-paid', ownerAuth, (req, res) => {
  const r = ownReminder(req, 'approved');
  const p = db.payments.find((x) => x.id === r.paymentId);
  if (p) markPaid(p, 'shopkeeper');
  else settleReminder(r, 'Marked paid by shopkeeper');
  res.json(r);
});


// ---- AI agent 1: Shopping assistant ----
// A customer's free-text list ("2 atta, 1L oil, doodh") -> the nearby shops that can fill most of it.
// The AgenticOrg agent parses the list and calls find_shops_for_list over MCP; if AgenticOrg is
// unreachable we run the same matcher on a simple local parse, and say so in the UI.
const SYNONYMS = {
  doodh: 'milk', dudh: 'milk', chawal: 'basmati', rice: 'basmati', aloo: 'potato', pyaz: 'onion', pyaaz: 'onion', kanda: 'onion',
  tamatar: 'tomato', cheeni: 'sugar', chini: 'sugar', namak: 'salt', chai: 'tea', biscuit: 'parle', biscuits: 'parle',
  noodles: 'maggi', detergent: 'surf', makhan: 'butter', kela: 'banana', seb: 'apple', dhaniya: 'coriander', mirchi: 'chilli',
  tel: 'oil', paracetamol: 'dolo', fever: 'dolo', sanitizer: 'sanitiser', bandage: 'band-aid',
};
const tokens = (str) => String(str).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean)
  .map((t) => SYNONYMS[t] || t.replace(/(?<=[a-z]{3})s$/, ''));

function parseList(text) {
  return String(text || '').split(/,|\n|;|\band\b|&|\+/i).map((part) => part.trim()).filter(Boolean).slice(0, 25).map((part) => {
    // "2 atta", "atta x2", "3 packets maggi"; sizes like "1kg"/"500 ml" are not quantities.
    const m = part.match(/^(\d{1,2})\s*(?:x|nos?|pcs?|packets?|packs?)?\s+(?!kg|g|gm|l|ml|ltr|litre|liter)\b(.+)$/i) || part.match(/^(.+?)\s*(?:x|×)\s*(\d{1,2})$/i);
    const qty = m ? Number(/^\d/.test(m[1]) ? m[1] : m[2]) : 1;
    const name = (m ? (/^\d/.test(m[1]) ? m[2] : m[1]) : part).replace(/\b\d+(\.\d+)?\s*(kg|g|gm|l|ml|ltr|litre|liter)s?\b/gi, '').trim() || part;
    return { name, qty: Math.max(1, Math.min(qty, 20)) };
  });
}

function bestProduct(shopId, wanted) {
  const want = tokens(wanted).filter((t) => !/^\d/.test(t));
  if (!want.length) return null;
  let best = null;
  for (const p of db.products.filter((x) => x.shopId === shopId && x.stock > 0)) {
    const have = tokens(p.name + ' ' + p.category);
    const score = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.startsWith(w)))).length / want.length;
    if (score >= 0.5 && (!best || score > best.score || (score === best.score && p.price < best.p.price))) best = { p, score };
  }
  return best?.p;
}

const km = (a, b) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

function matchShops({ items, area, location }) {
  const wanted = (items || []).filter((i) => i?.name).slice(0, 25).map((i) => ({ name: String(i.name).slice(0, 60), qty: Math.max(1, Math.min(Number(i.qty) || 1, 20)) }));
  const from = validPoint(location) ? location : AREA_CENTERS[area];
  const rank = (inArea) => db.shops.filter(planActive).filter((s) => !inArea || s.area === inArea || isPremium(s)).map((shop) => {
    const found = [], missing = [];
    for (const w of wanted) {
      const p = bestProduct(shop.id, w.name);
      if (p) found.push({ wanted: w.name, productId: p.id, name: p.name, price: p.price, qty: Math.min(w.qty, p.stock) });
      else missing.push(w.name);
    }
    return {
      shopId: shop.id, shopName: shop.shopName, area: shop.area, premium: isPremium(shop), delivery: isPremium(shop),
      found, missing, coverage: wanted.length ? found.length / wanted.length : 0,
      total: found.reduce((t, f) => t + f.price * f.qty, 0),
      distanceKm: from && Number.isFinite(shop.lat) ? Math.round(km(from, shop) * 10) / 10 : null,
    };
  }).filter((s) => s.found.length)
    .sort((a, b) => b.coverage - a.coverage || (a.distanceKm ?? 99) - (b.distanceKm ?? 99) || a.total - b.total)
    .slice(0, 3);
  // Nothing in the customer's area? Look across all areas rather than come back empty.
  let shops = rank(area), widened = false;
  if (!shops.length && area) { shops = rank(null); widened = shops.length > 0; }
  const nowhere = wanted.filter((w) => !shops.some((s) => s.found.some((f) => f.wanted === w.name))).map((w) => w.name);
  return { wanted, shops, nowhere, widened };
}

function localSummary(r) {
  if (!r.shops.length) return `Sorry, no open shop nearby has these items right now.`;
  const top = r.shops[0];
  return `${r.widened ? 'Nothing in your area, but ' : ''}${top.shopName} has ${top.found.length} of your ${r.wanted.length} items for about ₹${top.total}${top.distanceKm != null ? `, ${top.distanceKm} km away` : ''}.` +
    (top.missing.length ? ` Not there: ${top.missing.join(', ')}.` : ' Everything is in stock!') +
    (r.nowhere.length ? ` Nobody nearby has ${r.nowhere.join(', ')} right now.` : '');
}

app.post('/api/assistant/shop', customerAuth, async (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) fail(400, 'Tell us what you need, e.g. 2 atta, 1 oil, milk');
  const c = req.customer;
  const location = validPoint(req.body.location) ? req.body.location : null;
  const a = { id: id(), customerId: c.id, text, area: c.area, location, at: now() };
  db.assists.push(a);

  if (agenticorg.isConfigured('shopper')) {
    try {
      const run = await agenticorg.runAgent('shopper', {
        task: `Customer shopping list: "${text}". Find the best nearby shops.`, requestId: a.id, area: c.area, lat: location?.lat, lng: location?.lng,
      });
      a.agentStatus = run.status;
      a.summary = agenticorg.outputText(run.output);
      log('agent', 'agenticorg_run', { agent: 'shopper', requestId: a.id, runId: run.runId, status: run.status });
    } catch (err) {
      log('agent', 'agenticorg_run_failed', { agent: 'shopper', requestId: a.id, error: err.message });
    }
  }
  // The agent stores its matches through the MCP tool; without them, fall back to the local matcher.
  if (!a.result) {
    a.result = matchShops({ items: parseList(text), area: c.area, location });
    a.source = 'local';
  } else {
    a.source = 'agenticorg';
  }
  a.summary ||= localSummary(a.result);
  log('customer', 'assistant_query', { requestId: a.id, items: a.result.wanted.length, source: a.source, missed: a.result.nowhere });
  res.json({ source: a.source, agentStatus: a.agentStatus, summary: a.summary, ...a.result });
});

// ---- AI agent 2: Demand advisor (Premium) ----
// Reads area-level order trends (never another shop's customers) plus what shoppers asked the
// assistant for and couldn't find, and suggests what this shop should stock more of.
function areaDemand(area, days = 14) {
  const t = Date.now();
  const inArea = new Set(db.shops.filter((s) => !area || s.area === area).map((s) => s.id));
  const orders = db.orders.filter((o) => inArea.has(o.shopId) && o.status !== 'cancelled');
  const tally = (from, to) => {
    const m = {};
    for (const o of orders.filter((o) => t - Date.parse(o.at) >= from * DAY && t - Date.parse(o.at) < to * DAY)) {
      for (const l of o.items) {
        const p = db.products.find((x) => x.id === l.productId);
        m[l.name] ??= { product: l.name, category: p?.category || 'Other', qty: 0, orders: 0, shops: new Set() };
        m[l.name].qty += l.qty; m[l.name].orders++; m[l.name].shops.add(o.shopId);
      }
    }
    return m;
  };
  const cur = tally(0, days), prev = tally(days, days * 2);
  const products = Object.values(cur).map((x) => ({
    product: x.product, category: x.category, qty: x.qty, orders: x.orders, shopsSelling: x.shops.size,
    growthPct: prev[x.product]?.qty ? Math.round(((x.qty - prev[x.product].qty) / prev[x.product].qty) * 100) : null,
  })).sort((a, b) => b.qty - a.qty);
  const categories = {};
  for (const p of products) categories[p.category] = (categories[p.category] || 0) + p.qty;
  const missed = {};
  for (const a of db.assists.filter((a) => (!area || a.area === area) && t - Date.parse(a.at) < days * DAY && a.result)) {
    for (const n of a.result.nowhere) missed[n.toLowerCase()] = (missed[n.toLowerCase()] || 0) + 1;
  }
  return {
    area: area || 'all areas', days,
    topProducts: products.slice(0, 12),
    rising: products.filter((p) => p.growthPct !== null && p.growthPct >= 20 && p.qty >= 3).sort((a, b) => b.growthPct - a.growthPct).slice(0, 6),
    categories: Object.entries(categories).map(([category, qty]) => ({ category, qty })).sort((a, b) => b.qty - a.qty),
    missedSearches: Object.entries(missed).map(([item, searches]) => ({ item, searches })).sort((a, b) => b.searches - a.searches).slice(0, 8),
  };
}

const shopInventory = (shopId) => db.products.filter((p) => p.shopId === shopId)
  .map(({ id, name, category, stock, lowStockAt, price }) => ({ productId: id, name, category, stock, lowStockAt, price }));

function saveStockSuggestions({ shopId, summary, suggestions, source }) {
  const shop = db.shops.find((s) => s.id === shopId);
  if (!shop) throw new Error('Unknown shopId');
  const clean = (suggestions || []).slice(0, 10).map((sg) => {
    const p = sg.productId ? db.products.find((x) => x.id === sg.productId && x.shopId === shopId) : bestProduct(shopId, sg.product || '') || db.products.find((x) => x.shopId === shopId && x.name.toLowerCase() === String(sg.product).toLowerCase());
    return {
      product: String(sg.product || p?.name || '').slice(0, 80), productId: p?.id || null,
      action: p ? (['stock_more', 'promote'].includes(sg.action) ? sg.action : 'stock_more') : 'add_new',
      suggestedQty: Math.max(0, Math.min(Number(sg.suggestedQty) || 0, 500)), reason: String(sg.reason || '').slice(0, 240), status: 'pending',
    };
  }).filter((sg) => sg.product);
  const advice = { id: id(), shopId, summary: String(summary || '').slice(0, 600), suggestions: clean, source: source || 'agenticorg', at: now() };
  db.stockAdvice.push(advice);
  log('agent', 'stock_advice_saved', { adviceId: advice.id, shopId, suggestions: clean.length, source: advice.source });
  return advice;
}

function localStockAdvice(shop) {
  const d = areaDemand(shop.area, 14);
  const inv = shopInventory(shop.id);
  const sug = [];
  for (const tp of d.topProducts.slice(0, 8)) {
    const mine = inv.find((p) => p.name === tp.product);
    const weekly = Math.ceil(tp.qty / 2 / Math.max(1, tp.shopsSelling));
    if (mine && mine.stock < Math.max(weekly, mine.lowStockAt * 2)) {
      sug.push({ productId: mine.productId, product: mine.name, action: 'stock_more', suggestedQty: Math.max(weekly * 2 - mine.stock, 5), reason: `${tp.qty} sold in ${d.area} in 14 days${tp.growthPct ? ` (${tp.growthPct > 0 ? '+' : ''}${tp.growthPct}%)` : ''}; you have ${mine.stock}.` });
    } else if (!mine && tp.qty >= 5) {
      sug.push({ product: tp.product, action: 'add_new', suggestedQty: weekly * 2, reason: `Popular in ${d.area} (${tp.qty} sold in 14 days) and you don't stock it.` });
    }
  }
  for (const m of d.missedSearches.slice(0, 3)) {
    if (!sug.some((s) => s.product.toLowerCase().includes(m.item))) sug.push({ product: m.item, action: 'add_new', suggestedQty: 10, reason: `${m.searches} shopper${m.searches > 1 ? 's' : ''} in ${d.area} searched for this and no shop had it.` });
  }
  const top = d.categories[0];
  return saveStockSuggestions({
    shopId: shop.id, source: 'local', suggestions: sug.slice(0, 6),
    summary: top ? `In ${d.area}, ${top.category} leads demand this fortnight.${d.rising[0] ? ` ${d.rising[0].product} is rising fastest (+${d.rising[0].growthPct}%).` : ''}` : `Not enough orders in ${d.area} yet.`,
  });
}

app.post('/api/owner/stock-advice', ownerAuth, async (req, res) => {
  const shop = req.shop;
  if (!isPremium(shop)) fail(402, 'The AI stock advisor is part of Premium');
  const before = db.stockAdvice.length;
  let agentStatus;
  if (agenticorg.isConfigured('demand')) {
    try {
      const run = await agenticorg.runAgent('demand', { task: `Suggest what shop ${shop.id} (${shop.shopName}, ${shop.area}) should stock more of.`, shopId: shop.id, area: shop.area });
      agentStatus = run.status;
      log('agent', 'agenticorg_run', { agent: 'demand', shopId: shop.id, runId: run.runId, status: run.status });
    } catch (err) {
      log('agent', 'agenticorg_run_failed', { agent: 'demand', shopId: shop.id, error: err.message });
    }
  }
  const fresh = db.stockAdvice.slice(before).find((a) => a.shopId === shop.id);
  res.json({ ...(fresh || localStockAdvice(shop)), agentStatus });
});

app.get('/api/owner/stock-advice', ownerAuth, (req, res) => {
  res.json(db.stockAdvice.filter((a) => a.shopId === req.shop.id).at(-1) || null);
});

// Human-in-the-loop: the owner accepts (restocks) or dismisses each suggestion.
app.post('/api/owner/stock-advice/:id/:index', ownerAuth, (req, res) => {
  const advice = db.stockAdvice.find((a) => a.id === req.params.id && a.shopId === req.shop.id);
  const sg = advice?.suggestions[Number(req.params.index)];
  if (!sg) fail(404, 'Suggestion not found');
  const { action, qty } = req.body;
  if (!['accept', 'dismiss'].includes(action)) fail(400, 'accept or dismiss');
  if (sg.status !== 'pending') return res.json(sg); // already handled: don't restock twice
  if (action === 'accept' && sg.productId) {
    const n = Number(qty ?? sg.suggestedQty);
    if (!Number.isInteger(n) || n < 1 || n > 10000) fail(400, 'Enter how many to add');
    moveStock(req.shop.id, [{ productId: sg.productId, qty: n }], +1, 'restock', `advice-${advice.id}-${req.params.index}`);
  }
  sg.status = action === 'accept' ? 'accepted' : 'dismissed';
  log('shopkeeper', `stock_advice_${sg.status}`, { adviceId: advice.id, product: sg.product });
  res.json(sg);
});

// ---- Agent tools (used by the AgenticOrg agents over MCP, or REST with x-api-key) ----
function getDues(shopId) {
  const result = db.shops.filter((s) => !shopId || s.id === shopId).map((shop) => ({
    shopId: shop.id,
    shopName: shop.shopName,
    ownerName: shop.ownerName,
    dues: balances(shop.id).filter((b) => b.balance > 0),
  })).filter((s) => s.dues.length);
  log('agent', 'read_dues', { shops: result.length });
  return result;
}

function getLowStock(shopId) {
  const result = db.shops.filter((s) => !shopId || s.id === shopId).map((shop) => ({
    shopId: shop.id,
    shopName: shop.shopName,
    lowStock: db.products.filter((p) => p.shopId === shop.id && p.stock <= p.lowStockAt).map(({ name, stock, unit }) => ({ name, stock, unit })),
  })).filter((s) => s.lowStock.length);
  log('agent', 'read_low_stock', { shops: result.length });
  return result;
}

function draftReminder({ shopId, customerPhone, message }) {
  const due = balances(shopId).find((b) => b.customerPhone === customerPhone);
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

app.get('/api/agent/dues', agentAuth, (req, res) => res.json(getDues(req.query.shopId)));

app.post('/api/agent/reminders', agentAuth, (req, res) => {
  try { res.json(draftReminder(req.body)); } catch (err) { res.status(400).json({ error: err.message }); }
});

// Remote MCP (Streamable HTTP, stateless) — register in AgenticOrg under Connectors > Remote MCP.
function buildMcpServer() {
  const server = new McpServer({ name: 'khata-agent', version: '1.3.0' });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  server.registerTool('get_dues', {
    description: 'List kirana shops with customers who owe money on khata (udhaar): shopId, shop/owner name, customer name, phone and balance in rupees. Pass shopId to check one shop.',
    inputSchema: { shopId: z.string().optional().describe('Only this shop') },
    annotations: { readOnlyHint: true },
  }, async ({ shopId }) => asText(getDues(shopId)));
  server.registerTool('get_low_stock', {
    description: 'List products that are at or below their low-stock level, per shop. Pass shopId to check one shop.',
    inputSchema: { shopId: z.string().optional().describe('Only this shop') },
    annotations: { readOnlyHint: true },
  }, async ({ shopId }) => asText(getLowStock(shopId)));
  server.registerTool('draft_reminder', {
    description: 'Save a polite payment-reminder DRAFT for one customer, written in the shopkeeper\'s name. Does not send anything: the shopkeeper must approve it in the app, which then creates a payment link.',
    inputSchema: {
      shopId: z.string().describe('shopId from get_dues'),
      customerPhone: z.string().describe('customerPhone from get_dues'),
      message: z.string().describe('Short reminder text in Hinglish, signed with the shop name'),
    },
  }, async (args) => {
    try { return asText(draftReminder(args)); } catch (err) { return { ...asText({ error: err.message }), isError: true }; }
  });
  server.registerTool('find_shops_for_list', {
    description: 'Shopping assistant: given a customer\'s shopping list (already split into items), return up to 3 nearby open shops ranked by how many items they have in stock, then distance, then price. Pass the requestId you were given so the app can show the result to the customer.',
    inputSchema: {
      requestId: z.string().optional().describe('requestId from the task inputs'),
      area: z.string().optional().describe('Customer area, e.g. Indiranagar'),
      lat: z.number().optional(), lng: z.number().optional(),
      items: z.array(z.object({ name: z.string().describe('Item in plain English, e.g. "atta", "milk", "sunflower oil"'), qty: z.number().optional() })).describe('Items to find'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ requestId, area, lat, lng, items }) => {
    const a = requestId && db.assists.find((x) => x.id === requestId);
    const result = matchShops({ items, area: area || a?.area, location: validPoint({ lat, lng }) ? { lat, lng } : a?.location });
    if (a) { a.result = result; save(); }
    log('agent', 'find_shops_for_list', { requestId, items: result.wanted.length, shops: result.shops.length });
    return asText(result);
  });
  server.registerTool('get_area_demand', {
    description: 'Demand advisor: area-level demand for the last N days: top products by quantity, rising products (growth vs the previous period), category totals, and items shoppers searched for that no shop had. Aggregates only; no customer data.',
    inputSchema: { area: z.string().describe('Area name, e.g. Indiranagar'), days: z.number().optional().describe('Window in days (default 14)') },
    annotations: { readOnlyHint: true },
  }, async ({ area, days }) => asText(areaDemand(area, Math.max(1, Math.min(Number(days) || 14, 60)))));
  server.registerTool('get_shop_inventory', {
    description: 'Demand advisor: one shop\'s products with current stock, low-stock level and price.',
    inputSchema: { shopId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ shopId }) => asText(shopInventory(shopId)));
  server.registerTool('save_stock_suggestions', {
    description: 'Demand advisor: save stock suggestions for a shop. They are only shown to the shop owner, who accepts or dismisses each one; nothing is ordered automatically.',
    inputSchema: {
      shopId: z.string(),
      summary: z.string().describe('2-3 sentence plain-language summary for the shop owner'),
      suggestions: z.array(z.object({
        product: z.string(), productId: z.string().optional().describe('productId from get_shop_inventory if the shop already sells it'),
        action: z.enum(['stock_more', 'add_new', 'promote']), suggestedQty: z.number().optional(), reason: z.string(),
      })).max(10),
    },
  }, async (args) => {
    try { return asText(saveStockSuggestions(args)); } catch (err) { return { ...asText({ error: err.message }), isError: true }; }
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

// Public proof log; phone numbers and emails are masked.
app.get('/api/logs', (req, res) => {
  res.json(JSON.parse(JSON.stringify(db.logs.slice().reverse())
    .replace(/\b(\d{2})\d{6}(\d{2})\b/g, '$1******$2')
    .replace(/\b([\w.+-])[\w.+-]*@([\w-]+\.[\w.]+)/g, '$1***@$2')));
});

app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Something went wrong' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Uncle Store on http://localhost:${port}`));
