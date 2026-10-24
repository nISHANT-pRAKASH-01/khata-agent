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

// One key per user action, so a retried request can't apply twice on the server.
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

const waUrl = (phone, text) => `https://wa.me/${String(phone || '').replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}?text=${encodeURIComponent(text)}`;
const hourLabel = (h) => { const f = (x) => `${((x + 11) % 12) + 1} ${x % 24 < 12 ? 'AM' : 'PM'}`; return `${f(h)}–${f(h + 1)}`; };

// "Sign in with Google" when a client ID is configured; otherwise a labelled demo email login.
async function mountSignIn(el, role, onToken) {
  const cfg = await api('/api/config');
  const finish = async (body) => onToken(await api('/api/auth/google', { body: { ...body, role } }));
  if (cfg.googleClientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (r) => finish({ credential: r.credential }) });
      google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill' });
    };
    document.head.appendChild(s);
    return;
  }
  el.innerHTML = `<p class="badge pending">Demo mode: Google sign-in not configured yet</p>
    <label>Gmail address</label><input id="demoEmail" type="email" placeholder="you@gmail.com">
    <label>Your name</label><input id="demoName">
    <button class="block" style="margin-top:8px" id="demoGo">Continue</button>`;
  $('demoGo').onclick = () => finish({ demoEmail: $('demoEmail').value.trim(), demoName: $('demoName').value.trim() });
}

// Opens a payment link: Pine Labs in a new tab, the test page in the same tab.
function openPayment(link, back = location.pathname) {
  if (!link) return;
  if (link.startsWith('/')) location.href = link + '&back=' + encodeURIComponent(back);
  else if (!window.open(link, '_blank')) location.href = link; // popup blocked
}
