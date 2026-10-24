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
import { seed, seedHabits, AREA_CENTERS } from './seed.js';

const DAY = 86400000;
const IST = 5.5 * 3600000;
// Online orders pay the platform ₹14; delivery orders also pay the shop's delivery fee.
// Customers pay everything to the shop's UPI, so platform fees build up as the shop's "fees due".
const PLATFORM_FEE = 14;
const DEFAULT_DELIVERY_FEE = 30;
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
// Very old data files predate the marketplace: add the mock marketplace alongside.
// Data files from before the inventory coach: give the demo shops their stock-keeping history.
if (db.products && !db.purchases) {
  db.purchases = []; db.stockCounts = [];
  seedHabits(db, { id });
}
if (!db.products) {
  const fresh = seed({ id, endOfDayIST, istMidnight });
  for (const k of Object.keys(fresh)) db[k] = [...(db[k] || []), ...fresh[k]];
}
for (const k of ['assists', 'stockAdvice', 'purchases', 'stockCounts', 'coachTips']) db[k] ??= [];
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
  deliveryFee: deliveryFeeOf(s), acceptsUpi: acceptsUpi(s), platformFee: PLATFORM_FEE,
});
const privateShop = (s) => ({
  ...publicShop(s), ownerName: s.ownerName, phone: s.phone, email: s.email, plan: s.plan, planActive: planActive(s),
  upiId: s.upiId || '', payeeName: s.payeeName || '', hasQr: Boolean(s.qrImage),
});
const deliveryFeeOf = (s) => Number.isFinite(s.deliveryFee) ? s.deliveryFee : DEFAULT_DELIVERY_FEE;
const acceptsUpi = (s) => Boolean(s.upiId || s.qrImage);
// What the shop earns from an order: items + delivery fee (the platform fee is not the shop's).
const shopRevenue = (o) => (o.itemsTotal ?? o.total) + (o.deliveryFee || 0);

// Platform fees owed by a shop: ₹14 per online order it confirmed, minus what it has already paid us.
function feesFor(shopId) {
  const charged = db.orders.filter((o) => o.shopId === shopId && o.platformFee && !['placed', 'cancelled'].includes(o.status))
    .reduce((t, o) => t + o.platformFee, 0);
  const paid = db.payments.filter((p) => p.shopId === shopId && p.kind === 'fees' && ['claimed', 'paid'].includes(p.status))
    .reduce((t, p) => t + p.amount, 0);
  return { charged, paid, due: Math.max(0, charged - paid) };
}
const shopOf = (o) => db.shops.find((s) => s.id === o.shopId);
// Centre of an area: the built-in demo areas, otherwise the average position of shops registered there.
function areaCenter(area) {
  if (!area) return null;
  if (AREA_CENTERS[area]) return AREA_CENTERS[area];
  const pins = db.shops.filter((s) => s.area?.toLowerCase() === String(area).toLowerCase() && Number.isFinite(s.lat));
  return pins.length ? { lat: pins.reduce((t, s) => t + s.lat, 0) / pins.length, lng: pins.reduce((t, s) => t + s.lng, 0) / pins.length } : null;
}
const allAreaCenters = () => Object.fromEntries([...new Set([...Object.keys(AREA_CENTERS), ...db.shops.map((s) => s.area)].filter(Boolean))]
  .map((a) => [a, areaCenter(a)]).filter(([, c]) => c));
const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

// ---- Email (fire-and-forget; never blocks or fails an order) ----
function notify(to, subject, text) {
  if (!to) return;
  if (!mailer.isConfigured()) return log('system', 'email_skipped', { subject, reason: 'Gmail not configured' });
  mailer.sendMail({ to, subject, text })
    .then(() => log('system', 'email_sent', { subject }))
    .catch((err) => log('system', 'email_failed', { subject, error: err.message }));
}

const itemsText = (o) => o.items.map((l) => `  • ${l.name} × ${l.qty} = ₹${l.price * l.qty}`).join('\n') +
  (o.platformFee ? `\n  Platform fee: ₹${o.platformFee}` : '') + (o.deliveryFee ? `\n  Delivery fee: ₹${o.deliveryFee}` : '') + `\n  Total: ₹${o.total}`;

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
  }
  save();
}

// Payer says "I've paid" on the QR page. Plans go live straight away (UTR kept for checking);
// orders wait for the shopkeeper to confirm the money arrived.
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

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' })); // room for an uploaded QR image
app.use(express.static('public'));
const baseUrl = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;

app.get('/api/config', (req, res) => res.json({
  paymentsLive: pinelabs.isConfigured(), emailOn: mailer.isConfigured(),
  googleClientId: process.env.GOOGLE_CLIENT_ID || null, demoMode: process.env.DEMO_MODE === '1', plans: PLANS, areas: allAreaCenters(),
}));

// ---- Accounts: email + password, and "Sign in with Google" when GOOGLE_CLIENT_ID is set ----
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function passwordOk(user, password) {
  if (!user?.passwordHash || typeof password !== 'string') return false;
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}

async function verifyGoogle(credential) {
  if (!process.env.GOOGLE_CLIENT_ID) fail(400, 'Google sign-in is not set up yet. Use email and password.');
  if (!credential) fail(400, 'Google sign-in missing');
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  const t = await r.json().catch(() => ({}));
  if (!r.ok || t.aud !== process.env.GOOGLE_CLIENT_ID || t.email_verified !== 'true') fail(401, 'Google sign-in failed');
  return { email: t.email.toLowerCase(), name: t.name || t.email.split('@')[0] };
}

const pendingOwners = new Map(); // signup ticket -> verified owner identity, until the shop is registered

// Shared by Google and password sign-in once we know who the person is.
function startSession(role, who, res) {
  if (role === 'owner') {
    const shop = db.shops.find((s) => s.email === who.email);
    if (!shop) {
      const ticket = token();
      pendingOwners.set(ticket, who);
      return res.json({ needsShop: true, ticket, name: who.name, email: who.email });
    }
    shop.token ??= token();
    save();
    return res.json({ shop: privateShop(shop), token: shop.token });
  }
  let c = db.customers.find((x) => x.email === who.email);
  if (!c) {
    c = { id: id(), name: who.name, email: who.email, passwordHash: who.passwordHash, passwordSalt: who.passwordSalt, at: now() };
    db.customers.push(c);
    log('customer', 'signup', { customerId: c.id, name: who.name, method: who.passwordHash ? 'password' : 'google' });
  }
  c.token ??= token();
  save();
  res.json({ customer: customerView(c), token: c.token });
}

app.post('/api/auth/google', async (req, res) => {
  startSession(req.body.role, await verifyGoogle(req.body.credential), res);
});

app.post('/api/auth/signup', (req, res) => {
  const { role, name, password } = req.body;
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) fail(400, 'Enter a valid email');
  if (!name?.trim()) fail(400, 'Enter your name');
  if (typeof password !== 'string' || password.length < 6) fail(400, 'Password must be at least 6 characters');
  const taken = role === 'owner' ? db.shops.some((s) => s.email === email) : db.customers.some((c) => c.email === email);
  if (taken) fail(409, 'An account with this email already exists. Sign in instead.');
  const { salt, hash } = hashPassword(password);
  startSession(role, { email, name: name.trim(), passwordHash: hash, passwordSalt: salt }, res);
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = req.body.role === 'owner' ? db.shops.find((s) => s.email === email) : db.customers.find((c) => c.email === email);
  if (user && !user.passwordHash) fail(400, 'This account uses Google sign-in.');
  if (!passwordOk(user, req.body.password)) fail(401, 'Wrong email or password');
  startSession(req.body.role, { email, name: user.ownerName || user.name }, res);
});

// ---- Customer side ----
const customerView = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, area: c.area, profileDone: Boolean(c.phone && c.area) });
const customerAuth = (req, res, next) => {
  req.customer = db.customers.find((c) => c.token && c.token === req.get('x-customer-token'));
  req.customer ? next() : res.status(401).json({ error: 'Please log in again' });
};

app.get('/api/customers/me', customerAuth, (req, res) => res.json(customerView(req.customer)));

app.patch('/api/customers/me', customerAuth, (req, res) => {
  const { name, phone, area } = req.body;
  if (!/^\d{10}$/.test(phone || '')) fail(400, 'Enter a 10-digit phone number');
  if (!area) fail(400, 'Choose your area');
  Object.assign(req.customer, { phone, area, name: name || req.customer.name });
  save();
  res.json(customerView(req.customer));
});

app.get('/api/areas', (req, res) => res.json(Object.keys(allAreaCenters()).sort()));

// ---- Place search for pinning a shop (OpenStreetMap Nominatim: free, max 1 request/second) ----
const geoCache = new Map();
let geoLast = 0;
async function nominatim(path) {
  if (geoCache.has(path)) return geoCache.get(path);
  const wait = geoLast + 1100 - Date.now();
  geoLast = Date.now() + Math.max(0, wait);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(`https://nominatim.openstreetmap.org/${path}`, {
    headers: { 'User-Agent': 'UncleStore/1.0 (local shops marketplace)', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(8000),
  }).catch(() => fail(502, 'Place search is not reachable right now. Use the map or "I\'m at my shop".'));
  if (!r.ok) fail(502, 'Place search is busy. Try again in a moment, or use the map.');
  const data = await r.json();
  geoCache.set(path, data);
  return data;
}
const areaName = (a = {}) => a.suburb || a.neighbourhood || a.quarter || a.city_district || a.village || a.town || a.city || a.county || '';
const AREA_TYPES = ['suburb', 'neighbourhood', 'quarter', 'city_district', 'village', 'town', 'residential'];
const placeOf = (x) => ({
  label: x.display_name, area: (AREA_TYPES.includes(x.addresstype) && x.name) || areaName(x.address) || x.name || x.display_name.split(',')[0],
  city: x.address?.city || x.address?.town || x.address?.state_district || '', lat: Number(x.lat), lng: Number(x.lon),
});

app.get('/api/geo/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 3) return res.json([]);
  const data = await nominatim(`search?format=jsonv2&addressdetails=1&limit=6&countrycodes=in&q=${encodeURIComponent(q)}`);
  // Areas (suburbs, neighbourhoods) before landmarks like stations, so the area name comes out right.
  res.json([...data].sort((a, b) => AREA_TYPES.includes(b.addresstype) - AREA_TYPES.includes(a.addresstype)).map(placeOf));
});

app.get('/api/geo/reverse', async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!validPoint({ lat, lng })) fail(400, 'Bad location');
  const x = await nominatim(`reverse?format=jsonv2&addressdetails=1&zoom=17&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`);
  res.json(x?.address ? placeOf(x) : { area: '', label: '', lat, lng });
});

// Premium shops are "featured" in every area; day-pass shops show only in their own area.
// Shops sorted by distance from the customer (live GPS if shared, else their area's centre).
// "Near" = within NEAR_KM (or, without GPS, in the customer's own area). Premium shops get their own
// "Featured" row at the top wherever they are — that's the reach they pay for.
// When few shops are near, the app also shows the farther ones so the list is never empty.
const NEAR_KM = 4;
const MIN_NEARBY = 6;
const isNear = (distanceKm, shop, area) => (distanceKm !== null && distanceKm <= NEAR_KM) || (!!area && shop.area === area);
const distanceFrom = (from, shop) => from && Number.isFinite(shop.lat) ? Math.round(km(from, shop) * 10) / 10 : null;

app.get('/api/market/shops', (req, res) => {
  const { area, q } = req.query;
  const live = { lat: Number(req.query.lat), lng: Number(req.query.lng) };
  const from = validPoint(live) ? live : areaCenter(area);
  const needle = (q || '').toLowerCase();
  const shops = db.shops.filter(planActive)
    .filter((s) => !needle || s.shopName.toLowerCase().includes(needle) ||
      db.products.some((p) => p.shopId === s.id && p.name.toLowerCase().includes(needle)))
    .map((s) => {
      const distanceKm = distanceFrom(from, s);
      return { ...publicShop(s), items: db.products.filter((p) => p.shopId === s.id && p.stock > 0).length, distanceKm,
        near: isNear(distanceKm, s, validPoint(live) ? null : area) };
    })
    .sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
  const featured = shops.filter((s) => s.premium);
  const near = shops.filter((s) => s.near && !s.premium);
  const far = shops.filter((s) => !s.near && !s.premium);
  res.json({ featured, near, far, showFar: near.length + featured.filter((s) => s.near).length < MIN_NEARBY, from: validPoint(live) ? 'gps' : from ? 'area' : 'none', nearKm: NEAR_KM });
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
  if (!['online', 'pay_at_shop'].includes(paymentMethod)) fail(400, 'Choose a payment method');
  if (paymentMethod === 'online' && !acceptsUpi(shop)) fail(400, 'This shop takes payment at pickup or delivery only');

  const lines = priceLines(shop.id, items);
  const itemsTotal = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const deliveryFee = fulfilment === 'delivery' ? deliveryFeeOf(shop) : 0;
  const order = {
    id: id(), idempotencyKey, shopId: shop.id, channel: 'online',
    customerId: c.id, customerName: c.name, customerPhone: c.phone, customerEmail: c.email,
    items: lines, itemsTotal, platformFee: PLATFORM_FEE, deliveryFee, total: itemsTotal + PLATFORM_FEE + deliveryFee,
    fulfilment, address: address || null,
    location: fulfilment === 'delivery' ? (validPoint(location) ? location : areaCenter(c.area) || { lat: shop.lat, lng: shop.lng }) : null,
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
    shopName: shop?.shopName, shopPhone: shop?.phone, shopArea: shop?.area, shopLocation: shop && { lat: shop.lat, lng: shop.lng },
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
  // Orders and bills are paid to the shop's own UPI; plan and platform fees to Uncle Store's QR.
  const shop = p.kind === 'order' && db.shops.find((s) => s.id === p.shopId);
  res.json({
    id: p.id, amount: p.amount, description: p.description, status: p.status, provider: p.provider, kind: p.kind,
    payee: shop
      ? { platform: false, name: shop.payeeName || shop.shopName, upiId: shop.upiId || null, qrImage: shop.qrImage ? `/api/shops/${shop.id}/qr` : null }
      : { platform: true, name: 'Uncle Store', upiId: null, qrImage: '/upi-qr.jpg' },
  });
});

app.get('/api/shops/:id/qr', (req, res) => {
  const shop = db.shops.find((s) => s.id === req.params.id);
  const m = shop?.qrImage?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!m) fail(404, 'No QR');
  res.type(m[1]).set('Cache-Control', 'no-cache').send(Buffer.from(m[2], 'base64'));
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
  if (!g) fail(401, 'Please sign in again');
  const { shopName, phone, area, category, location } = req.body;
  if (!shopName || !area) fail(400, 'Shop name and area are required');
  if (!/^\d{10}$/.test(phone || '')) fail(400, 'Enter a 10-digit phone number');
  if (db.shops.some((s) => s.email === g.email)) fail(409, 'This account already has a shop');
  // Never guess a far-away pin: without a picked location we only accept an area we already know.
  const pin = validPoint(location) ? location : areaCenter(area);
  if (!pin) fail(400, 'Set your shop location: search for it or tap "I\'m at my shop"');
  const shop = { id: id(), ownerName: g.name, email: g.email, passwordHash: g.passwordHash, passwordSalt: g.passwordSalt, shopName, phone, area, category: category || 'kirana', lat: pin.lat, lng: pin.lng, plan: null, token: token(), at: now() };
  db.shops.push(shop);
  pendingOwners.delete(req.body.ticket);
  log('shopkeeper', 'signup', { shopId: shop.id, shopName, area });
  res.json({ shop: privateShop(shop), token: shop.token });
});

// Phone + PIN only works for the seeded demo shops; real owners sign in with their account.
// Testing shortcut into the seeded sample shops. Only on when DEMO_MODE=1 (local), never on the live site.
const demoMode = process.env.DEMO_MODE === '1';
app.post('/api/owner/demo-login', (req, res) => {
  if (!demoMode) fail(404, 'Not found');
  const shop = db.shops.find((s) => s.mock && s.phone === req.body.phone && s.pin === req.body.pin);
  if (!shop) fail(401, 'Wrong demo phone or PIN');
  shop.token ??= token();
  save();
  res.json({ shop: privateShop(shop), token: shop.token });
});

// Owner settings: shop pin and area name, UPI ID / QR image for receiving money, delivery fee.
app.patch('/api/owner/shop', ownerAuth, (req, res) => {
  const { location, area, upiId, payeeName, qrImage, deliveryFee } = req.body;
  if (upiId !== undefined) {
    const v = String(upiId).trim();
    if (v && !/^[\w.\-]{2,64}@[a-zA-Z][\w]{1,32}$/.test(v)) fail(400, 'UPI ID looks wrong. It should look like name@okaxis or 9876543210@ybl');
    req.shop.upiId = v;
  }
  if (payeeName !== undefined) req.shop.payeeName = String(payeeName).trim().slice(0, 60);
  if (qrImage !== undefined) {
    if (qrImage === null) delete req.shop.qrImage;
    else {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(qrImage)) fail(400, 'Upload the QR as a PNG or JPG image');
      if (qrImage.length > 700000) fail(400, 'QR image is too large. Use a screenshot under 500 KB');
      req.shop.qrImage = qrImage;
    }
  }
  if (deliveryFee !== undefined) {
    const f = Number(deliveryFee);
    if (!Number.isInteger(f) || f < 0 || f > 200) fail(400, 'Delivery fee must be between ₹0 and ₹200');
    req.shop.deliveryFee = f;
  }
  if (location !== undefined) {
    if (!validPoint(location)) fail(400, 'Pick the shop location on the map');
    Object.assign(req.shop, { lat: Number(location.lat), lng: Number(location.lng) });
  }
  if (area !== undefined) {
    if (!String(area).trim()) fail(400, 'Area name is required');
    req.shop.area = String(area).trim().slice(0, 60);
  }
  log('shopkeeper', 'shop_settings_updated', { shopId: req.shop.id, fields: Object.keys(req.body).filter((k) => req.body[k] !== undefined) });
  res.json(privateShop(req.shop));
});

app.get('/api/owner/me', ownerAuth, (req, res) => {
  const mine = db.orders.filter((o) => o.shopId === req.shop.id);
  res.json({
    shop: privateShop(req.shop),
    toConfirm: mine.filter((o) => o.status === 'placed').length,
    openOrders: mine.filter((o) => ['placed', 'confirmed', 'packed', 'out_for_delivery'].includes(o.status)).length,
    lowStock: db.products.filter((p) => p.shopId === req.shop.id && p.stock <= p.lowStockAt).length,
    fees: feesFor(req.shop.id),
  });
});

// Shop pays its accumulated platform fees to Uncle Store (our QR).
app.post('/api/owner/fees/pay', ownerAuth, async (req, res) => {
  const { due } = feesFor(req.shop.id);
  if (!due) fail(400, 'No platform fees due');
  const open = db.payments.find((p) => p.shopId === req.shop.id && p.kind === 'fees' && p.status === 'pending' && p.amount === due);
  const p = open || await createPayment({ kind: 'fees', refId: req.shop.id, shopId: req.shop.id, amount: due, description: `Platform fees for ${req.shop.shopName}`, customerName: req.shop.ownerName, customerPhone: req.shop.phone });
  res.json({ paymentLink: p.link });
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
    const c = map[o.customerPhone] ??= { name: o.customerName, phone: o.customerPhone, email: o.customerEmail, orders: 0, spend: 0, orders30: 0, spend30: 0, firstOrderAt: o.at, lastOrderAt: o.at, items: {}, hours: {} };
    c.orders++;
    c.spend += shopRevenue(o);
    if (Date.now() - Date.parse(o.at) < 30 * DAY) { c.orders30++; c.spend30 += shopRevenue(o); }
    if (o.at < c.firstOrderAt) c.firstOrderAt = o.at;
    if (o.at > c.lastOrderAt) c.lastOrderAt = o.at;
    c.email ??= o.customerEmail;
    c.hours[istHour(o.at)] = (c.hours[istHour(o.at)] || 0) + 1;
    for (const l of o.items) c.items[l.name] = (c.items[l.name] || 0) + l.qty;
  }
  const list = Object.values(map);
  // Prime = this shop's top 20% by spend in the last 30 days (at least ₹2,000 and 2 orders).
  const spends = list.map((c) => c.spend30).sort((a, b) => b - a);
  const primeCutoff = Math.max(PRIME.minSpend30, spends[Math.max(0, Math.ceil(spends.length * PRIME.topShare) - 1)] ?? Infinity);
  const tierOf = (c) => c.spend30 >= primeCutoff && c.orders30 >= PRIME.minOrders30 ? 'prime' : c.orders > 1 ? 'regular' : 'new';
  return list.map(({ items, hours, ...c }) => {
    const [hour, count] = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
    return {
      ...c,
      favourites: Object.entries(items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, qty]) => ({ name, qty })),
      usualHour: Number(hour),
      usualHourShare: Math.round((count / c.orders) * 100),
      tier: tierOf(c),
    };
  }).sort((a, b) => b.lastOrderAt.localeCompare(a.lastOrderAt));
}

// Prime = a shop's best customers this month; Regular = has come back; New = one order so far.
const PRIME = { topShare: 0.2, minSpend30: 2000, minOrders30: 2 };

app.get('/api/owner/customers', ownerAuth, (req, res) => {
  const customers = shopCustomers(req.shop.id);
  const byOrders = [...customers].sort((a, b) => b.orders30 - a.orders30 || b.spend30 - a.spend30);
  const bySpend = [...customers].sort((a, b) => b.spend30 - a.spend30);
  res.json({
    customers,
    rules: PRIME,
    summary: {
      total: customers.length,
      prime: customers.filter((c) => c.tier === 'prime').length,
      repeatRate: customers.length ? Math.round((customers.filter((c) => c.orders > 1).length / customers.length) * 100) : 0,
      active30: customers.filter((c) => c.orders30 > 0).length,
      mostOrders: byOrders[0] && byOrders[0].orders30 ? { name: byOrders[0].name, orders30: byOrders[0].orders30 } : null,
      topSpender: bySpend[0] && bySpend[0].spend30 ? { name: bySpend[0].name, spend30: bySpend[0].spend30 } : null,
    },
  });
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
  if (!['cash', 'online'].includes(paymentMethod)) fail(400, 'Choose cash or UPI QR');
  if (paymentMethod === 'online' && !acceptsUpi(req.shop)) fail(400, 'Add your UPI ID or QR in Plan & settings first');
  if (customerPhone && !/^\d{10}$/.test(customerPhone)) fail(400, 'Phone must be 10 digits');
  let lines = priceLines(req.shop.id, items);
  const bill = {
    id: id(), idempotencyKey, shopId: req.shop.id, channel: 'walk_in', customerId: null, customerName: customerName || 'Walk-in', customerPhone: customerPhone || null,
    items: lines, itemsTotal: lines.reduce((t, l) => t + l.price * l.qty, 0), total: lines.reduce((t, l) => t + l.price * l.qty, 0), fulfilment: 'counter',
    paymentMethod, paymentStatus: paymentMethod === 'cash' ? 'paid' : 'pending', status: 'completed', timeline: [{ status: 'completed', at: now() }], at: now(),
  };
  let payment;
  if (paymentMethod === 'online') {
    payment = await createPayment({ kind: 'order', refId: bill.id, shopId: req.shop.id, amount: bill.total, description: `Bill at ${req.shop.shopName}`, customerName, customerPhone });
    bill.paymentId = payment.id;
    lines = priceLines(req.shop.id, items); // stock may have moved while we waited on Pine Labs
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
  const revenue = (list) => list.reduce((s, o) => s + shopRevenue(o), 0);
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

// ---- Inventory: wholesale stock-in and stock counts ----
// A wholesale delivery is entered as a purchase bill; stock goes up once per purchase (idempotency key).
app.post('/api/owner/purchases', ownerAuth, (req, res) => {
  const { supplier, invoiceNo, lines, idempotencyKey } = req.body;
  if (!validKey(idempotencyKey)) fail(400, 'Missing idempotency key');
  const existing = db.purchases.find((x) => x.shopId === req.shop.id && x.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ ...existing, duplicate: true });
  if (!supplier?.trim()) fail(400, 'Who did you buy from? Enter the supplier name');
  if (!Array.isArray(lines) || !lines.length) fail(400, 'Add at least one item');
  const priced = lines.map((l) => {
    const p = db.products.find((x) => x.id === l.productId && x.shopId === req.shop.id);
    const qty = Number(l.qty), cost = Number(l.cost);
    if (!p) fail(400, 'Item not found. Add new items under "Add a product" first');
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) fail(400, `Quantity for ${p.name} must be a whole number`);
    if (!(cost > 0) || cost > 100000) fail(400, `Enter the cost price for ${p.name}`);
    return { productId: p.id, name: p.name, qty, cost };
  });
  const purchase = {
    id: id(), idempotencyKey, shopId: req.shop.id, supplier: supplier.trim().slice(0, 80), invoiceNo: String(invoiceNo || '').trim().slice(0, 40),
    lines: priced, total: priced.reduce((t, l) => t + l.qty * l.cost, 0), at: now(),
  };
  db.purchases.push(purchase);
  moveStock(req.shop.id, priced, +1, 'purchase', purchase.id);
  for (const l of priced) db.products.find((p) => p.id === l.productId).cost = l.cost;
  log('shopkeeper', 'wholesale_purchase', { purchaseId: purchase.id, supplier: purchase.supplier, items: priced.length, total: purchase.total });
  res.json(purchase);
});

app.get('/api/owner/purchases', ownerAuth, (req, res) => {
  res.json(db.purchases.filter((x) => x.shopId === req.shop.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20)
    .map(({ idempotencyKey, ...x }) => x));
});

// Physical count: the shelf is the truth. Any shortfall was most likely sold without a bill.
app.post('/api/owner/stock-count', ownerAuth, (req, res) => {
  const { counts, idempotencyKey } = req.body;
  if (!validKey(idempotencyKey)) fail(400, 'Missing idempotency key');
  const existing = db.stockCounts.find((x) => x.shopId === req.shop.id && x.idempotencyKey === idempotencyKey);
  if (existing) return res.json({ ...existing, duplicate: true });
  if (!Array.isArray(counts) || !counts.length) fail(400, 'Count at least one item');
  const lines = counts.map((c) => {
    const p = db.products.find((x) => x.id === c.productId && x.shopId === req.shop.id);
    const counted = Number(c.counted);
    if (!p) fail(400, 'Item not found');
    if (!Number.isInteger(counted) || counted < 0 || counted > 100000) fail(400, `Enter a whole number for ${p.name}`);
    return { productId: p.id, name: p.name, expected: p.stock, counted, diff: counted - p.stock };
  });
  const count = { id: id(), idempotencyKey, shopId: req.shop.id, lines, at: now() };
  db.stockCounts.push(count);
  moveStock(req.shop.id, lines.filter((l) => l.diff).map((l) => ({ productId: l.productId, qty: l.diff })), +1, 'count_adjust', count.id);
  log('shopkeeper', 'stock_count', { countId: count.id, items: lines.length, missing: -lines.filter((l) => l.diff < 0).reduce((t, l) => t + l.diff, 0), extra: lines.filter((l) => l.diff > 0).reduce((t, l) => t + l.diff, 0) });
  const { idempotencyKey: _, ...out } = count;
  res.json(out);
});

// ---- AI agent 3: Inventory coach ----
// Measures the shop's stock-keeping habits and teaches the owner to keep the system in sync with the shelf.
function inventoryHabits(shopId) {
  const t = Date.now();
  const recent = (x, days = 30) => t - Date.parse(x.at) < days * DAY;
  const moves = db.stockMoves.filter((m) => m.shopId === shopId && recent(m));
  const units = (reason, sign = 1) => moves.filter((m) => m.reason === reason && Math.sign(m.delta) === sign).reduce((n, m) => n + Math.abs(m.delta), 0);
  const billedUnits = db.orders.filter((o) => o.shopId === shopId && o.status !== 'cancelled' && recent(o))
    .reduce((n, o) => n + o.items.reduce((k, l) => k + l.qty, 0), 0);
  const unbilledUnits = units('count_adjust', -1);
  const purchaseUnits = units('purchase'), quickAddUnits = units('restock');
  const purchases = db.purchases.filter((x) => x.shopId === shopId).sort((a, b) => b.at.localeCompare(a.at));
  const counts = db.stockCounts.filter((x) => x.shopId === shopId).sort((a, b) => b.at.localeCompare(a.at));
  const lastCount = counts[0];
  const daysAgo = (x) => x ? Math.floor((t - Date.parse(x.at)) / DAY) : null;
  const billDays = new Set(db.orders.filter((o) => o.shopId === shopId && recent(o, 7)).map((o) => istDay(o.at))).size;
  const products = db.products.filter((p) => p.shopId === shopId);
  const sold = {};
  for (const o of db.orders.filter((o) => o.shopId === shopId && o.status !== 'cancelled' && recent(o))) for (const l of o.items) sold[l.productId] = (sold[l.productId] || 0) + l.qty;
  const topSellers = products.filter((p) => sold[p.id]).sort((a, b) => sold[b.id] - sold[a.id]).slice(0, 8);
  const topOut = topSellers.filter((p) => p.stock === 0).map((p) => p.name);
  const topLow = topSellers.filter((p) => p.stock > 0 && p.stock <= p.lowStockAt).map((p) => p.name);
  const missingItems = lastCount ? lastCount.lines.filter((l) => l.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5).map((l) => ({ name: l.name, missing: -l.diff })) : [];
  const noCost = products.filter((p) => !p.cost).length;

  const billingRate = billedUnits + unbilledUnits ? billedUnits / (billedUnits + unbilledUnits) : 1;
  const entryRate = purchaseUnits + quickAddUnits ? purchaseUnits / (purchaseUnits + quickAddUnits) : 0;
  const countAge = daysAgo(lastCount);
  const countScore = countAge === null ? 0 : countAge <= 7 ? 1 : countAge <= 14 ? 0.5 : 0.2;
  const shelfScore = topSellers.length ? 1 - (topOut.length + topLow.length * 0.5) / topSellers.length : 1;
  const parts = {
    billing: { score: Math.round(billingRate * 40), max: 40, label: 'Every sale billed', detail: `${billedUnits} units billed, ${unbilledUnits} found missing at counts (30 days)` },
    wholesale: { score: Math.round(entryRate * 25), max: 25, label: 'Wholesale deliveries entered', detail: `${purchaseUnits} units entered from wholesale bills, ${quickAddUnits} added with quick "+ Add"` },
    counting: { score: Math.round(countScore * 20), max: 20, label: 'Weekly stock count', detail: countAge === null ? 'Never counted' : `Last count ${countAge === 0 ? 'today' : countAge + ' days ago'}` },
    shelf: { score: Math.round(Math.max(0, shelfScore) * 15), max: 15, label: 'Top sellers on the shelf', detail: topOut.length || topLow.length ? `${[...topOut.map((n) => n + ' (out)'), ...topLow.map((n) => n + ' (low)')].join(', ')}` : 'All top sellers in stock' },
  };
  return {
    score: Object.values(parts).reduce((n, p) => n + p.score, 0), parts,
    billedUnits, unbilledUnits, billingRatePct: Math.round(billingRate * 100), purchaseUnits, quickAddUnits,
    lastPurchaseDaysAgo: daysAgo(purchases[0]), purchases30: purchases.filter((x) => recent(x)).length,
    lastCountDaysAgo: countAge, missingAtLastCount: missingItems, billDaysLast7: billDays,
    topSellersOut: topOut, topSellersLow: topLow, productsWithoutCost: noCost, products: products.length,
  };
}

function lessons(shopId, h) {
  const today = istDay(Date.now());
  return [
    { id: 'wholesale', title: 'Enter every wholesale delivery', done: h.lastPurchaseDaysAgo !== null && h.lastPurchaseDaysAgo <= 7,
      steps: ['When the wholesaler\'s goods arrive, keep their bill (parchi) in hand.', 'Open Inventory → 📦 Wholesale stock-in.', 'Enter the supplier, bill number, and each item with quantity and cost price.', 'Save. Stock goes up, and your margins are now known.'],
      why: 'If stock comes in without an entry, the app thinks you have less than you do, and online customers see "out of stock".' },
    { id: 'bill', title: 'Bill every sale, even ₹10', done: db.orders.some((o) => o.shopId === shopId && o.channel === 'walk_in' && istDay(o.at) === today),
      steps: ['Customer at the counter? Open Billing.', 'Tap Add on each item, or search it.', 'Choose Cash or UPI QR, then save.', 'Stock goes down by itself; no need to subtract anything.'],
      why: 'Every sale without a bill makes your stock look higher than the shelf. Then you promise items online that you don\'t have.' },
    { id: 'count', title: 'Count your stock once a week', done: h.lastCountDaysAgo !== null && h.lastCountDaysAgo <= 7,
      steps: ['Pick a quiet time, e.g. Sunday morning.', 'Open Inventory → 🧮 Count stock.', 'Type what is actually on the shelf. Start with your 10 fastest-selling items.', 'Save. Anything missing shows up; those were usually sold without a bill.'],
      why: 'The count fixes any mismatch and shows you where sales are slipping through without bills.' },
    { id: 'alerts', title: 'Never run out of best-sellers', done: !h.topSellersOut.length && !h.topSellersLow.length,
      steps: ['Check the ⚠ items in Inventory every evening.', 'Add them to tomorrow\'s wholesale list.', 'When they arrive, enter them with 📦 Wholesale stock-in.'],
      why: 'A customer who finds an empty shelf may go to the next shop and not come back.' },
  ];
}

function localCoachTips(shop, h) {
  const tips = [];
  if (h.unbilledUnits > 0) {
    const worst = h.missingAtLastCount.slice(0, 3).map((m) => `${m.name} (${m.missing})`).join(', ');
    tips.push({ habit: 'billing', tip: `At your stock counts, ${h.unbilledUnits} ${h.unbilledUnits === 1 ? 'unit was' : 'units were'} missing${worst ? `: ${worst}` : ''}. These were most likely sold without a bill. Make Billing the first thing you open for every counter sale, even for one Maggi.` });
  }
  if (h.quickAddUnits > h.purchaseUnits) {
    tips.push({ habit: 'wholesale', tip: `${h.quickAddUnits} units were added with quick "+ Add" but only ${h.purchaseUnits} through a wholesale bill. Use 📦 Wholesale stock-in when goods arrive, so you also record cost price and the supplier. Then you'll know your real profit on each item.` });
  } else if (h.lastPurchaseDaysAgo === null || h.lastPurchaseDaysAgo > 7) {
    tips.push({ habit: 'wholesale', tip: `No wholesale delivery entered ${h.lastPurchaseDaysAgo === null ? 'yet' : `in ${h.lastPurchaseDaysAgo} days`}. Next time goods arrive, enter them before they go on the shelf. It takes about 2 minutes with the bill in hand.` });
  }
  if (h.lastCountDaysAgo === null || h.lastCountDaysAgo > 7) {
    tips.push({ habit: 'counting', tip: `${h.lastCountDaysAgo === null ? 'You have never counted your stock.' : `Your last stock count was ${h.lastCountDaysAgo} days ago.`} Pick a fixed time each week (Sunday morning works for most shops) and count your 10 fastest-selling items first.` });
  }
  if (h.topSellersOut.length || h.topSellersLow.length) {
    tips.push({ habit: 'shelf', tip: `Your best-sellers are running out: ${[...h.topSellersOut, ...h.topSellersLow].slice(0, 4).join(', ')}. Put them on your next wholesale list today.` });
  }
  if (h.billDaysLast7 < 5) tips.push({ habit: 'billing', tip: `You billed on only ${h.billDaysLast7} of the last 7 days. If the shop was open on the other days, those sales are missing from your stock.` });
  if (!tips.length) tips.push({ habit: 'all', tip: 'Shabash! Your stock-keeping is in great shape. Keep billing every sale and counting weekly.' });
  const weakest = Object.entries(h.parts).sort((a, b) => a[1].score / a[1].max - b[1].score / b[1].max)[0];
  return saveCoachTips({
    shopId: shop.id, source: 'local', tips: tips.slice(0, 4),
    summary: `Your stock-keeping score is ${h.score}/100. Focus this week: ${weakest[1].label.toLowerCase()}.`,
  });
}

function saveCoachTips({ shopId, summary, tips, source }) {
  if (!db.shops.some((s) => s.id === shopId)) throw new Error('Unknown shopId');
  const entry = {
    id: id(), shopId, source: source || 'agenticorg', summary: String(summary || '').slice(0, 500),
    tips: (tips || []).slice(0, 6).map((x) => ({ habit: String(x.habit || 'general').slice(0, 20), tip: String(x.tip || '').slice(0, 400) })).filter((x) => x.tip),
    at: now(),
  };
  db.coachTips.push(entry);
  log('agent', 'coach_tips_saved', { shopId, tips: entry.tips.length, source: entry.source });
  return entry;
}

// Plain answers for the most common questions, used when the AgenticOrg coach isn't reachable.
const FAQ = [
  [/wholesale|supplier|delivery|purchase|maal|aaya|stock.?in|arrived|bought/i, 'When goods arrive from the wholesaler: open Inventory → 📦 Wholesale stock-in. Enter the supplier and bill number, then each item with quantity and cost price, and save. Stock goes up by itself. If an item is new, first add it under "+ Add a product" with opening stock 0.'],
  [/bill|sale|sold|counter|customer.*buy|becha/i, 'For every counter sale: open Billing, tap Add on each item, choose Cash or UPI QR, and save. Stock goes down by itself. Bill even small sales; unbilled sales are why the app\'s stock and your shelf stop matching.'],
  [/count|mismatch|missing|wrong|shelf|match|galat/i, 'If the app\'s stock doesn\'t match the shelf: open Inventory → 🧮 Count stock, type what you actually have, and save. The app corrects itself and shows what was missing, which was usually sold without a bill. Do this once a week.'],
  [/damage|expired|broken|kharab|waste|return/i, 'For damaged or expired items: open 🧮 Count stock and enter the good quantity left. The difference is removed from stock. For items you return to the supplier, do the same after the return.'],
  [/new (item|product)|add (item|product)|naya/i, 'To add a new item: Inventory → "+ Add a product". Put opening stock as 0, then enter the actual quantity through 📦 Wholesale stock-in so the cost price is recorded too.'],
  [/price|rate|mrp|cost|margin|profit/i, 'To change a selling price, tap the price in Inventory. The cost price comes from your wholesale stock-in entries, so always enter the wholesale rate there. That is how you know your profit on each item.'],
  [/low|out of stock|khatam|reorder|alert/i, 'Items marked ⚠ in Inventory are at or below their alert level. Check them every evening and put them on tomorrow\'s wholesale list. Premium shops also get the AI stock advisor in Insights.'],
];

app.get('/api/owner/coach', ownerAuth, (req, res) => {
  const h = inventoryHabits(req.shop.id);
  res.json({ habits: h, lessons: lessons(req.shop.id, h), tips: db.coachTips.filter((x) => x.shopId === req.shop.id).at(-1) || null });
});

app.post('/api/owner/coach/tips', ownerAuth, async (req, res) => {
  const shop = req.shop;
  const before = db.coachTips.length;
  let agentStatus;
  if (agenticorg.isConfigured('coach')) {
    try {
      const run = await agenticorg.runAgent('coach', { task: `Coach shop ${shop.id} (${shop.shopName}) on keeping inventory accurate.`, shopId: shop.id, ownerName: shop.ownerName });
      agentStatus = run.status;
      log('agent', 'agenticorg_run', { agent: 'coach', shopId: shop.id, runId: run.runId, status: run.status });
    } catch (err) {
      log('agent', 'agenticorg_run_failed', { agent: 'coach', shopId: shop.id, error: err.message });
    }
  }
  const fresh = db.coachTips.slice(before).find((x) => x.shopId === shop.id);
  res.json({ ...(fresh || localCoachTips(shop, inventoryHabits(shop.id))), agentStatus });
});

app.post('/api/owner/coach/ask', ownerAuth, async (req, res) => {
  const question = String(req.body.question || '').trim().slice(0, 300);
  if (!question) fail(400, 'Type your question');
  const shop = req.shop;
  if (agenticorg.isConfigured('coach')) {
    try {
      const run = await agenticorg.runAgent('coach', { task: `Shop owner question: "${question}". Answer simply in 2-4 short steps.`, question, shopId: shop.id, ownerName: shop.ownerName });
      log('agent', 'agenticorg_run', { agent: 'coach', shopId: shop.id, runId: run.runId, status: run.status });
      const answer = agenticorg.outputText(run.output);
      if (run.status === 'completed' && answer) return res.json({ answer, source: 'agenticorg' });
    } catch (err) {
      log('agent', 'agenticorg_run_failed', { agent: 'coach', shopId: shop.id, error: err.message });
    }
  }
  const hit = FAQ.find(([re]) => re.test(question));
  log('shopkeeper', 'coach_question', { shopId: shop.id, matched: Boolean(hit) });
  res.json({
    source: 'local',
    answer: hit ? hit[1] : 'I can help with: entering wholesale deliveries, billing every sale, counting stock, damaged or expired items, adding new items, prices and margins, and low-stock alerts. Try asking about one of these.',
  });
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
  const from = validPoint(location) ? location : areaCenter(area);
  const all = db.shops.filter(planActive).map((shop) => {
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
      distanceKm: distanceFrom(from, shop),
      near: isNear(distanceFrom(from, shop), shop, validPoint(location) ? null : area),
    };
  }).filter((s) => s.found.length)
    .sort((a, b) => b.coverage - a.coverage || (a.distanceKm ?? 99) - (b.distanceKm ?? 99) || a.total - b.total);
  // Nearby shops first; if fewer than 3 nearby have anything, fill up with farther ones.
  const nearby = all.filter((s) => s.near).slice(0, 3);
  const shops = nearby.length >= 3 ? nearby : [...nearby, ...all.filter((s) => !s.near)].slice(0, 3);
  const widened = shops.some((s) => !s.near);
  const nowhere = wanted.filter((w) => !shops.some((s) => s.found.some((f) => f.wanted === w.name))).map((w) => w.name);
  return { wanted, shops, nowhere, widened };
}

function localSummary(r) {
  if (!r.shops.length) return `Sorry, no open shop nearby has these items right now.`;
  const top = r.shops[0];
  return `${r.widened && !top.near ? 'Not much nearby, but ' : ''}${top.shopName} has ${top.found.length} of your ${r.wanted.length} items for about ₹${top.total}${top.distanceKm != null ? `, ${top.distanceKm} km away` : ''}.` +
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
function getLowStock(shopId) {
  const result = db.shops.filter((s) => !shopId || s.id === shopId).map((shop) => ({
    shopId: shop.id,
    shopName: shop.shopName,
    lowStock: db.products.filter((p) => p.shopId === shop.id && p.stock <= p.lowStockAt).map(({ name, stock, unit }) => ({ name, stock, unit })),
  })).filter((s) => s.lowStock.length);
  log('agent', 'read_low_stock', { shops: result.length });
  return result;
}

const agentAuth = (req, res, next) =>
  req.get('x-api-key') === process.env.AGENT_API_KEY ||
  req.get('authorization') === `Bearer ${process.env.AGENT_API_KEY}`
    ? next()
    : res.status(401).json({ error: 'Bad API key' });

// Remote MCP (Streamable HTTP, stateless) — register in AgenticOrg under Connectors > Remote MCP.
function buildMcpServer() {
  const server = new McpServer({ name: 'uncle-store', version: '2.0.0' });
  const asText = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  server.registerTool('get_low_stock', {
    description: 'List products that are at or below their low-stock level, per shop. Pass shopId to check one shop.',
    inputSchema: { shopId: z.string().optional().describe('Only this shop') },
    annotations: { readOnlyHint: true },
  }, async ({ shopId }) => asText(getLowStock(shopId)));
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
  server.registerTool('get_inventory_habits', {
    description: 'Inventory coach: how well a shop keeps its stock records in sync with the shelf (last 30 days): billed vs unbilled units found at stock counts, wholesale entries vs quick adds, days since last count/purchase, best-sellers out or low, and a 0-100 score broken into parts.',
    inputSchema: { shopId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ shopId }) => asText(inventoryHabits(shopId)));
  server.registerTool('save_coach_tips', {
    description: 'Inventory coach: save personalised coaching tips for a shop owner. They are shown in the Coach tab; nothing is changed in the shop.',
    inputSchema: {
      shopId: z.string(),
      summary: z.string().describe('One or two encouraging sentences with the score and the one habit to focus on this week'),
      tips: z.array(z.object({ habit: z.enum(['billing', 'wholesale', 'counting', 'shelf', 'general']), tip: z.string() })).max(6),
    },
  }, async (args) => {
    try { return asText(saveCoachTips(args)); } catch (err) { return { ...asText({ error: err.message }), isError: true }; }
  });
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
