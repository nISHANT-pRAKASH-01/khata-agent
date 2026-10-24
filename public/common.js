// Shared helpers for every page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const label = (s) => String(s || '').replace(/_/g, ' ');

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// fetch wrapper: JSON in/out, auth header, errors shown as a toast.
async function api(path, { method, body, headers } = {}) {
  const res = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error || 'Something went wrong');
    const err = new Error(data.error);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Opens a payment link: Pine Labs in a new tab, the test page in the same tab.
function openPayment(link, back = location.pathname) {
  if (!link) return;
  if (link.startsWith('/')) location.href = link + '&back=' + encodeURIComponent(back);
  else if (!window.open(link, '_blank')) location.href = link; // popup blocked
}
