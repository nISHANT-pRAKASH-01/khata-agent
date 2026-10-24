import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as pinelabs from './pinelabs.js';
import * as agenticorg from './agenticorg.js';
import { seed } from './seed.js';

const DAY = 86400000;
const IST = 5.5 * 3600000;
const PLANS = { day: { price: 100, label: 'Day pass' }, premium: { price: 5000, label: 'Premium (30 days)' } };

const id = () => crypto.randomUUID().slice(0, 8);
const token = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const istDay = (t) => new Date(new Date(t).getTime() + IST).toISOString().slice(0, 10);
const endOfDayIST = (d) => new Date(Date.parse(`${istDay(d)}T23:59:59.999Z`) - IST);

const DATA_FILE = process.env.DATA_FILE || 'data.json';
const db = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : seed({ id, endOfDayIST });
// Older data files (khata-only) predate the marketplace: add the mock marketplace alongside.
if (!db.products) {
  const fresh = seed({ id, endOfDayIST });
  for (const k of Object.keys(fresh)) db[k] = [...(db[k] || []), ...fresh[k]];
}
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
  id: s.id, shopName: s.shopName, ownerName: s.ownerName, area: s.area, category: s.category,
  premium: isPremium(s), delivery: isPremium(s), open: planActive(s),
});
const privateShop = (s) => ({ ...publicShop(s), phone: s.phone, plan: s.plan, planActive: planActive(s) });

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

function moveStock(shopId, lines, sign, reason, refId) {
  for (const l of lines) {
    const p = db.products.find((x) => x.id === l.productId);
    if (!p) continue;
    p.stock += sign * l.qty;
    db.stockMoves.push({ id: id(), shopId, productId: p.id, delta: sign * l.qty, reason, refId, at: now() });
  }
}

// ---- Payments: Pine Labs payment link, or a clearly-labelled test page when keys aren't set ----
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
    Object.assign(p, { provider: 'test', link: `/pay.html?id=${p.id}` });
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
  log(source, 'payment_received', { paymentId: p.id, kind: p.kind, refId: p.refId, amount: p.amount });
  if (p.kind === 'order') {
    const o = db.orders.find((x) => x.id === p.refId);
    if (o) o.paymentStatus = 'paid';
  } else if (p.kind === 'plan') {
    const shop = db.shops.find((s) => s.id === p.shopId);
    if (shop) activatePlan(shop, p.refId);
  } else if (p.kind === 'khata') {
    const r = db.reminders.find((x) => x.id === p.refId);
    if (r && r.status === 'approved') settleReminder(r, `Paid via ${p.provider} link ${p.providerId || p.id}`);
  }
  save();
}

function settleReminder(r, note) {
  r.status = 'paid';
  addKhata(r.shopId, { customerName: r.customerName, customerPhone: r.customerPhone, amount: r.amount, type: 'payment', note });
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/config', (req, res) => res.json({
  paymentsLive: pinelabs.isConfigured(), agentConnected: agenticorg.isConfigured(), plans: PLANS,
}));

// ---- Customer side ----
const customerAuth = (req, res, next) => {
  req.customer = db.customers.find((c) => c.token && c.token === req.get('x-customer-token'));
  req.customer ? next() : res.status(401).json({ error: 'Please log in again' });
};

app.post('/api/customers/login', (req, res) => {
  const { name, phone, area } = req.body;
  if (!name || !/^\d{10}$/.test(phone || '')) fail(400, 'Name and a 10-digit phone number are required');
  let c = db.customers.find((x) => x.phone === phone);
  if (!c) {
    c = { id: id(), name, phone, area, at: now() };
    db.customers.push(c);
    log('customer', 'signup', { customerId: c.id, name, area });
  }
  c.token ??= token();
  if (area) c.area = area;
  save();
  res.json({ customer: { id: c.id, name: c.name, phone: c.phone, area: c.area }, token: c.token });
});

app.get('/api/areas', (req, res) => res.json([...new Set(db.shops.map((s) => s.area).filter(Boolean))].sort()));

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

app.post('/api/orders', customerAuth, async (req, res) => {
  const { shopId, items, fulfilment, address, paymentMethod } = req.body;
  const shop = db.shops.find((s) => s.id === shopId);
  if (!shop || !planActive(shop)) fail(400, 'This shop is not taking orders today');
  if (!['pickup', 'delivery'].includes(fulfilment)) fail(400, 'Choose pickup or delivery');
  if (fulfilment === 'delivery' && !isPremium(shop)) fail(400, 'This shop offers pickup only');
  if (fulfilment === 'delivery' && !address) fail(400, 'Delivery address required');
  if (!['online', 'pay_at_shop', 'khata'].includes(paymentMethod)) fail(400, 'Choose a payment method');

  let lines = priceLines(shop.id, items);
  const c = req.customer;
  const order = {
    id: id(), shopId: shop.id, channel: 'online', customerId: c.id, customerName: c.name, customerPhone: c.phone,
    items: lines, total: lines.reduce((t, l) => t + l.price * l.qty, 0), fulfilment, address: address || null,
    paymentMethod, paymentStatus: 'pending', status: 'placed', at: now(),
  };
  let payment;
  if (paymentMethod === 'online') {
    payment = await createPayment({ kind: 'order', refId: order.id, shopId: shop.id, amount: order.total, description: `Order at ${shop.shopName}`, customerName: c.name, customerPhone: c.phone });
    order.paymentId = payment.id;
    lines = priceLines(shop.id, items); // stock may have moved while we waited on Pine Labs
  }
  moveStock(shop.id, lines, -1, 'order', order.id);
  db.orders.push(order);
  log('customer', 'order_placed', { orderId: order.id, shopId: shop.id, total: order.total, fulfilment, paymentMethod });
  res.json({ order, paymentLink: payment?.link });
});

app.get('/api/customers/me/orders', customerAuth, (req, res) => {
  res.json(db.orders.filter((o) => o.customerId === req.customer.id && !o.mock).reverse().map((o) => ({
    ...o,
    shopName: db.shops.find((s) => s.id === o.shopId)?.shopName,
    paymentLink: o.paymentStatus === 'pending' ? db.payments.find((p) => p.id === o.paymentId)?.link : undefined,
  })));
});

app.post('/api/orders/:id/cancel', customerAuth, (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.customerId === req.customer.id);
  if (!o || o.status !== 'placed') fail(400, 'Only orders the shop has not accepted yet can be cancelled');
  o.status = 'cancelled';
  moveStock(o.shopId, o.items, +1, 'cancel', o.id);
  log('customer', 'order_cancelled', { orderId: o.id });
  res.json(o);
});

// ---- Payment pages ----
app.get('/api/payments/:id', (req, res) => {
  const p = db.payments.find((x) => x.id === req.params.id);
  if (!p) fail(404, 'Payment not found');
  res.json({ id: p.id, amount: p.amount, description: p.description, status: p.status, provider: p.provider, kind: p.kind });
});

app.post('/api/payments/:id/test-pay', (req, res) => {
  const p = db.payments.find((x) => x.id === req.params.id);
  if (!p || p.provider !== 'test') fail(400, 'Not a test payment');
  markPaid(p, 'test_payment');
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

// ---- Shop owner side ----
const ownerAuth = (req, res, next) => {
  req.shop = db.shops.find((s) => s.token && s.token === req.get('x-owner-token'));
  req.shop ? next() : res.status(401).json({ error: 'Please log in again' });
};

app.post('/api/owner/signup', (req, res) => {
  const { ownerName, shopName, phone, pin, area, category } = req.body;
  if (!ownerName || !shopName || !area) fail(400, 'Name, shop name and area are required');
  if (!/^\d{10}$/.test(phone || '')) fail(400, 'Enter a 10-digit phone number');
  if (!/^\d{4}$/.test(pin || '')) fail(400, 'PIN must be 4 digits');
  if (db.shops.some((s) => s.phone === phone)) fail(409, 'A shop with this phone already exists. Log in instead.');
  const shop = { id: id(), ownerName, shopName, phone, pin, area, category: category || 'kirana', plan: null, token: token(), at: now() };
  db.shops.push(shop);
  log('shopkeeper', 'signup', { shopId: shop.id, shopName, ownerName, area });
  res.json({ shop: privateShop(shop), token: shop.token });
});

app.post('/api/owner/login', (req, res) => {
  const shop = db.shops.find((s) => s.phone === req.body.phone && s.pin === req.body.pin);
  if (!shop) fail(401, 'Wrong phone or PIN');
  shop.token ??= token();
  save();
  res.json({ shop: privateShop(shop), token: shop.token });
});

app.get('/api/owner/me', ownerAuth, (req, res) => {
  const mine = db.orders.filter((o) => o.shopId === req.shop.id);
  res.json({
    shop: privateShop(req.shop),
    openOrders: mine.filter((o) => ['placed', 'accepted', 'ready', 'out_for_delivery'].includes(o.status)).length,
    lowStock: db.products.filter((p) => p.shopId === req.shop.id && p.stock <= p.lowStockAt).length,
  });
});

app.get('/api/owner/orders', ownerAuth, (req, res) => {
  res.json(db.orders.filter((o) => o.shopId === req.shop.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60));
});

const NEXT = { placed: ['accepted', 'cancelled'], accepted: ['ready', 'out_for_delivery', 'cancelled'], ready: ['completed'], out_for_delivery: ['completed'] };
app.post('/api/owner/orders/:id/status', ownerAuth, (req, res) => {
  const o = db.orders.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  const { status } = req.body;
  if (!o || !NEXT[o.status]?.includes(status)) fail(400, `Can't move this order to ${status}`);
  if (status === 'out_for_delivery' && o.fulfilment !== 'delivery') fail(400, 'This is a pickup order');
  if (status === 'ready' && o.fulfilment === 'delivery') fail(400, 'This is a delivery order');
  // Accepting a khata order is the shopkeeper agreeing to give credit.
  if (status === 'accepted' && o.paymentMethod === 'khata') {
    addKhata(o.shopId, { customerName: o.customerName, customerPhone: o.customerPhone, amount: o.total, type: 'credit', note: `Order ${o.id}` });
    o.paymentStatus = 'on_khata';
  }
  if (status === 'cancelled') {
    moveStock(o.shopId, o.items, +1, 'cancel', o.id);
    if (o.paymentStatus === 'on_khata') addKhata(o.shopId, { customerName: o.customerName, customerPhone: o.customerPhone, amount: o.total, type: 'payment', note: `Order ${o.id} cancelled` });
  }
  if (status === 'completed' && o.paymentMethod === 'pay_at_shop') o.paymentStatus = 'paid';
  o.status = status;
  log('shopkeeper', `order_${status}`, { orderId: o.id });
  res.json(o);
});

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

app.post('/api/owner/products/:id/restock', ownerAuth, (req, res) => {
  const p = db.products.find((x) => x.id === req.params.id && x.shopId === req.shop.id);
  const qty = Number(req.body.qty);
  if (!p) fail(404, 'Product not found');
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000) fail(400, 'Restock quantity must be a whole number above 0');
  moveStock(p.shopId, [{ productId: p.id, qty }], +1, 'restock');
  log('shopkeeper', 'restocked', { productId: p.id, name: p.name, qty, stock: p.stock });
  res.json(p);
});

// Walk-in billing at the counter: stock goes down immediately.
app.post('/api/owner/bills', ownerAuth, async (req, res) => {
  const { items, customerName, customerPhone, paymentMethod } = req.body;
  if (!['cash', 'online', 'khata'].includes(paymentMethod)) fail(400, 'Choose cash, payment link or khata');
  if (paymentMethod !== 'cash' && (!customerName || !/^\d{10}$/.test(customerPhone || ''))) fail(400, 'Customer name and 10-digit phone needed for link or khata');
  let lines = priceLines(req.shop.id, items);
  const bill = {
    id: id(), shopId: req.shop.id, channel: 'walk_in', customerId: null, customerName: customerName || 'Walk-in', customerPhone: customerPhone || null,
    items: lines, total: lines.reduce((t, l) => t + l.price * l.qty, 0), fulfilment: 'counter',
    paymentMethod, paymentStatus: paymentMethod === 'cash' ? 'paid' : 'pending', status: 'completed', at: now(),
  };
  let payment;
  if (paymentMethod === 'online') {
    payment = await createPayment({ kind: 'order', refId: bill.id, shopId: req.shop.id, amount: bill.total, description: `Bill at ${req.shop.shopName}`, customerName, customerPhone });
    bill.paymentId = payment.id;
    lines = priceLines(req.shop.id, items);
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

  const byCustomer = {};
  for (const o of last30.filter((o) => o.customerPhone)) {
    byCustomer[o.customerPhone] ??= { name: o.customerName, orders: 0, spend: 0 };
    byCustomer[o.customerPhone].orders++;
    byCustomer[o.customerPhone].spend += o.total;
  }
  const customers = Object.values(byCustomer);

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
    topCustomers: customers.sort((a, b) => b.spend - a.spend).slice(0, 5),
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
  if (!agenticorg.isConfigured()) fail(503, 'AgenticOrg agent not connected yet');
  log('shopkeeper', 'asked_agent', { shopId: shop.id });
  try {
    const run = await agenticorg.runAgent({ shopId: shop.id, shopName: shop.shopName, task: 'Check dues for this shop and draft reminders' });
    log('agent', 'agenticorg_run', { shopId: shop.id, runId: run.runId, status: run.status });
    res.json(run);
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

// ---- Agent tools (used by the AgenticOrg agent over MCP, or REST with x-api-key) ----
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
  const server = new McpServer({ name: 'khata-agent', version: '1.1.0' });
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
    description: 'Save a polite payment-reminder DRAFT for one customer, written in the shopkeeper\'s name. Does not send anything: the shopkeeper must approve it in the app, which then creates a Pine Labs payment link.',
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

// Public proof log; phone numbers are masked.
app.get('/api/logs', (req, res) => {
  res.json(JSON.parse(JSON.stringify(db.logs.slice().reverse()).replace(/\b(\d{2})\d{6}(\d{2})\b/g, '$1******$2')));
});

app.use((err, req, res, next) => {
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err instanceof HttpError ? err.message : 'Something went wrong' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Khata Agent on http://localhost:${port}`));
