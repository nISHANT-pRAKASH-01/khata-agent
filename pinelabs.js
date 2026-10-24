// Pine Labs Online (Plural) payment links.
// Endpoints/body follow Plural v2 docs — confirm with the Pine Labs help desk and adjust if they differ.
const BASE = process.env.PINELABS_BASE_URL || 'https://pluraluat.v2.pinepg.in';

export const isConfigured = () =>
  Boolean(process.env.PINELABS_CLIENT_ID && process.env.PINELABS_CLIENT_SECRET);

async function getToken() {
  const res = await fetch(`${BASE}/api/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.PINELABS_CLIENT_ID,
      client_secret: process.env.PINELABS_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Pine Labs token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function createPaymentLink({ amountRupees, description, reference, customerName, customerPhone }) {
  const token = await getToken();
  const res = await fetch(`${BASE}/api/pay/v1/paymentlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      amount: { value: Math.round(amountRupees * 100), currency: 'INR' },
      description,
      merchant_payment_link_reference: reference,
      customer: { first_name: customerName, mobile_number: customerPhone },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Pine Labs payment link failed: ${JSON.stringify(data)}`);
  return { url: data.payment_link, id: data.payment_link_id, raw: data };
}
