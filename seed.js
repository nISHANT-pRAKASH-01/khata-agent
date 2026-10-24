// Mock marketplace data so the app is usable on first boot. Everything here is flagged
// `mock: true` and never written to the activity log, so it can't be mistaken for real users.
const DAY = 86400000;

// Deterministic pseudo-random so every fresh boot has the same demo data.
let s = 42;
const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const CATALOG = {
  kirana: [
    ['Aashirvaad Atta 5kg', 'Staples', 'pack', 265], ['India Gate Basmati 1kg', 'Staples', 'pack', 140],
    ['Toor Dal 1kg', 'Staples', 'kg', 160], ['Fortune Sunflower Oil 1L', 'Staples', 'bottle', 155],
    ['Tata Salt 1kg', 'Staples', 'pack', 28], ['Sugar 1kg', 'Staples', 'kg', 46],
    ['Amul Taaza Milk 500ml', 'Dairy', 'pouch', 28], ['Amul Butter 100g', 'Dairy', 'pack', 58],
    ['Parle-G 250g', 'Snacks', 'pack', 25], ['Maggi Noodles 4-pack', 'Snacks', 'pack', 56],
    ['Tata Tea Gold 250g', 'Beverages', 'pack', 150], ['Surf Excel 1kg', 'Household', 'pack', 140],
  ],
  fresh: [
    ['Onion 1kg', 'Vegetables', 'kg', 40], ['Potato 1kg', 'Vegetables', 'kg', 30],
    ['Tomato 1kg', 'Vegetables', 'kg', 36], ['Banana (dozen)', 'Fruits', 'dozen', 60],
    ['Apple Shimla 1kg', 'Fruits', 'kg', 180], ['Coriander bunch', 'Vegetables', 'bunch', 10],
    ['Green Chilli 250g', 'Vegetables', 'pack', 15], ['Paneer 200g', 'Dairy', 'pack', 90],
  ],
  medical: [
    ['Dolo 650 (strip)', 'Medicines', 'strip', 32], ['Vicks VapoRub 50ml', 'Personal care', 'jar', 145],
    ['Dettol Antiseptic 125ml', 'First aid', 'bottle', 75], ['Band-Aid (20)', 'First aid', 'box', 50],
    ['ORS sachet', 'Medicines', 'sachet', 21], ['Hand sanitiser 200ml', 'Personal care', 'bottle', 99],
  ],
};

// Rough centres of each demo area (Bengaluru), used for shop pins and as a delivery fallback.
export const AREA_CENTERS = {
  Indiranagar: { lat: 12.9719, lng: 77.6412 },
  Koramangala: { lat: 12.9352, lng: 77.6245 },
  'HSR Layout': { lat: 12.9116, lng: 77.6474 },
};

const SHOPS = [
  { shopName: 'Sharma General Store', ownerName: 'Rakesh Sharma', phone: '9810000001', area: 'Indiranagar', category: 'kirana', plan: 'premium' },
  { shopName: 'Gupta Kirana', ownerName: 'Sunita Gupta', phone: '9810000002', area: 'Koramangala', category: 'kirana', plan: 'day' },
  { shopName: 'Fresh Mandi', ownerName: 'Imran Khan', phone: '9810000003', area: 'Indiranagar', category: 'fresh', plan: 'premium' },
  { shopName: 'Apna Medical', ownerName: 'Deepa Nair', phone: '9810000004', area: 'HSR Layout', category: 'medical', plan: 'day' },
  { shopName: 'Balaji Provisions', ownerName: 'Venkat Rao', phone: '9810000005', area: 'HSR Layout', category: 'kirana', plan: 'day' },
];

// [name, phone, usual ordering hour in IST] — gives the timing agent a real pattern to find.
const CUSTOMERS = [
  ['Ramesh', '9900000011', 8], ['Priya', '9900000012', 19], ['Arjun', '9900000013', 21],
  ['Meena', '9900000014', 10], ['Farhan', '9900000015', 18], ['Kavya', '9900000016', 20],
];

export function seed({ id, endOfDayIST, istMidnight }) {
  const now = Date.now();
  const db = { shops: [], customers: [], products: [], orders: [], payments: [], stockMoves: [], views: [], logs: [], purchases: [], stockCounts: [] };
  const jitter = () => (rand() - 0.5) * 0.02;

  for (const c of CUSTOMERS) db.customers.push({ id: id(), name: c[0], phone: c[1], prefHour: c[2], area: pick(SHOPS).area, mock: true, at: new Date(now - 40 * DAY).toISOString() });

  for (const sh of SHOPS) {
    const validUntil = sh.plan === 'premium' ? new Date(now + 30 * DAY) : endOfDayIST(new Date(now));
    const shop = {
      id: id(), shopName: sh.shopName, ownerName: sh.ownerName, phone: sh.phone, pin: '1234', area: sh.area, category: sh.category,
      lat: AREA_CENTERS[sh.area].lat + jitter(), lng: AREA_CENTERS[sh.area].lng + jitter(),
      plan: { type: sh.plan, validUntil: validUntil.toISOString() }, mock: true, at: new Date(now - 45 * DAY).toISOString(),
    };
    db.shops.push(shop);
    const products = CATALOG[sh.category].map(([name, category, unit, price]) => ({
      id: id(), shopId: shop.id, name, category, unit, price, cost: Math.round(price * (0.78 + rand() * 0.1)), stock: 5 + Math.floor(rand() * 40), lowStockAt: 5, mock: true,
    }));
    // A couple of items start low so the low-stock alert has something to show.
    products[1].stock = 3;
    products[4].stock = 0;
    db.products.push(...products);

    // Past orders (online + walk-in) so the premium insights have history.
    const nOrders = sh.plan === 'premium' ? 70 : 15;
    for (let i = 0; i < nOrders; i++) {
      const cust = pick(db.customers);
      const hour = cust.prefHour + (rand() < 0.7 ? 0 : Math.round((rand() - 0.5) * 4)) + rand();
      const at = new Date(Math.min(now - 60000, istMidnight(now - Math.floor(1 + rand() * 29) * DAY) + hour * 3600000));
      const lines = [];
      for (let j = 0, n = 1 + Math.floor(rand() * 3); j < n; j++) {
        // Skew towards the first few products so "top sellers" is meaningful.
        const p = products[Math.floor(rand() * rand() * products.length)];
        if (lines.some((l) => l.productId === p.id)) continue;
        lines.push({ productId: p.id, name: p.name, price: p.price, qty: 1 + Math.floor(rand() * 3) });
      }
      const walkIn = rand() < 0.4;
      db.orders.push({
        id: id(), shopId: shop.id, channel: walkIn ? 'walk_in' : 'online',
        customerId: cust.id, customerName: cust.name, customerPhone: cust.phone,
        items: lines, total: lines.reduce((t, l) => t + l.price * l.qty, 0),
        fulfilment: walkIn ? 'counter' : (sh.plan === 'premium' && rand() < 0.5 ? 'delivery' : 'pickup'),
        paymentMethod: pick(['online', 'pay_at_shop', 'cash']), paymentStatus: 'paid', status: 'completed',
        mock: true, at: at.toISOString(),
      });
    }
    for (let i = 0; i < (sh.plan === 'premium' ? 400 : 60); i++) {
      db.views.push({ shopId: shop.id, mock: true, at: new Date(now - Math.floor(rand() * 30 * DAY)).toISOString() });
    }
  }

  seedHabits(db, { id });

  return db;
}

// Inventory habits for the coach: Sharma enters every wholesale delivery and counts weekly;
// Gupta tops up stock with quick "+ Add" and its last count found items sold without a bill.
export function seedHabits(db, { id }) {
  const now = Date.now();
  const habits = { 'Sharma General Store': 'good', 'Gupta Kirana': 'poor' };
  db.shops.filter((shop) => shop.mock).forEach((shop, si) => {
    const habit = habits[shop.shopName] || 'average';
    const products = db.products.filter((p) => p.shopId === shop.id);
    for (const p of products) p.cost ??= Math.round(p.price * 0.83); // older data had no cost price
    const purchases = { good: 4, average: 1, poor: 0 }[habit];
    for (let i = 0; i < purchases; i++) {
      const at = new Date(now - (3 + i * 7) * DAY).toISOString();
      const lines = products.slice(i % 3, (i % 3) + 4).map((p) => ({ productId: p.id, name: p.name, qty: 10 + Math.floor(rand() * 20), cost: p.cost }));
      const pid = id();
      db.purchases.push({ id: pid, shopId: shop.id, supplier: pick(['Metro Cash & Carry', 'Jumbotail', 'Sri Lakshmi Wholesale', 'Udaan']), invoiceNo: `INV-${1000 + si * 100 + i}`, lines, total: lines.reduce((t, l) => t + l.qty * l.cost, 0), mock: true, at });
      for (const l of lines) db.stockMoves.push({ id: id(), shopId: shop.id, productId: l.productId, delta: l.qty, reason: 'purchase', refId: pid, mock: true, at });
    }
    const quickAdds = { good: 1, average: 4, poor: 9 }[habit];
    for (let i = 0; i < quickAdds; i++) {
      const p = pick(products);
      db.stockMoves.push({ id: id(), shopId: shop.id, productId: p.id, delta: 5 + Math.floor(rand() * 15), reason: 'restock', mock: true, at: new Date(now - Math.floor(1 + rand() * 25) * DAY).toISOString() });
    }
    if (habit !== 'average') {
      const cid = id();
      const at = new Date(now - (habit === 'good' ? 3 : 12) * DAY).toISOString();
      const lines = products.slice(0, 8).map((p, i) => {
        const diff = habit === 'good' ? (i === 2 ? -1 : 0) : -[3, 0, 5, 2, 0, 4, 1, 0][i];
        return { productId: p.id, name: p.name, expected: p.stock - diff, counted: p.stock, diff };
      });
      db.stockCounts.push({ id: cid, shopId: shop.id, lines, mock: true, at });
      for (const l of lines.filter((l) => l.diff)) db.stockMoves.push({ id: id(), shopId: shop.id, productId: l.productId, delta: l.diff, reason: 'count_adjust', refId: cid, mock: true, at });
    }
  });
}
