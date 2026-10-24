// Shared helpers for every page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', Number.isInteger(Number(n || 0)) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

// Email + password sign in / create account, plus "Sign in with Google" when a client ID is configured.
async function mountSignIn(el, role, onToken) {
  const cfg = await api('/api/config');
  let mode = 'login';
  el.innerHTML = `
    <div id="gBtn" style="margin:8px 0"></div>
    ${cfg.googleClientId ? '<p class="muted" style="text-align:center;margin:8px 0">or use your email</p>' : ''}
    <div class="tabs" style="margin-top:0"><button type="button" data-m="login" class="active">Sign in</button><button type="button" data-m="signup">Create account</button></div>
    <form id="authForm">
      <div id="nameRow" class="hidden"><label>Your name</label><input id="aName" autocomplete="name"></div>
      <label>Email</label><input id="aEmail" type="email" autocomplete="email" placeholder="you@gmail.com" required>
      <label>Password</label><input id="aPass" type="password" autocomplete="current-password" minlength="6" required>
      <button class="block" style="margin-top:12px" id="authGo">Sign in</button>
    </form>`;
  const setMode = (m) => {
    mode = m;
    el.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    $('nameRow').classList.toggle('hidden', m !== 'signup');
    $('aPass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    $('authGo').textContent = m === 'signup' ? 'Create account' : 'Sign in';
  };
  el.querySelectorAll('[data-m]').forEach((b) => b.onclick = () => setMode(b.dataset.m));
  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    $('authGo').disabled = true;
    try {
      onToken(await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { body: {
        role, email: $('aEmail').value.trim(), password: $('aPass').value, name: $('aName').value.trim(),
      } }));
    } catch (err) {
      if (err.status === 409) setMode('login');
    } finally { $('authGo').disabled = false; }
  };
  if (cfg.googleClientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: async (r) => onToken(await api('/api/auth/google', { body: { credential: r.credential, role } })) });
      google.accounts.id.renderButton($('gBtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 300 });
    };
    document.head.appendChild(s);
  }
}

// Straight-line distance in km, and a friendly travel estimate (roads ≈ 1.3× the straight line).
function distKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return null;
  const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function travelText(km) {
  if (km == null) return '';
  const road = km * 1.3;
  return road < 1 ? `${Math.max(50, Math.round(km * 100) * 10)} m · ${Math.max(1, Math.round((road / 5) * 60))} min walk`
    : `${km.toFixed(1)} km · ${Math.max(2, Math.round((road / 18) * 60))} min by bike`;
}
const directionsUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

// Location picker for a shop or a customer's home. The map shows straight away: one tap on
// "Use my current location", a search, or a tap on the map drops the pin; it can then be dragged.
// Needs Leaflet on the page. Returns { value() } -> { location, area }.
function locationPicker(el, { initial, area, center, what = 'shop' } = {}) {
  let pin = initial && Number.isFinite(initial.lat) ? { lat: initial.lat, lng: initial.lng } : null;
  let areaEdited = Boolean(area), marker, timer;
  const here = what === 'shop' ? "I'm at my shop: use my current location" : 'Use my current location';
  el.innerHTML = `
    <button type="button" class="block lp-gps">📍 ${here}</button>
    <p class="muted" style="text-align:center;margin:8px 0">or search, or tap on the map</p>
    <input class="lp-q" placeholder="Type area or address, e.g. Whitefield, Bengaluru" autocomplete="off">
    <div class="lp-results"></div>
    <div class="lp-map" style="height:280px;border-radius:12px;margin-top:8px"></div>
    <p class="lp-sel" style="margin:8px 0"></p>
    <label>Area name ${what === 'shop' ? '(shown to customers)' : ''}</label><input class="lp-area" placeholder="e.g. Whitefield">`;
  const q = el.querySelector('.lp-q'), results = el.querySelector('.lp-results'), areaInput = el.querySelector('.lp-area'), sel = el.querySelector('.lp-sel');
  areaInput.value = area || '';
  areaInput.oninput = () => { areaEdited = true; };
  const showSelected = (text) => {
    sel.innerHTML = pin ? `✅ <strong>Selected:</strong> ${esc(text || `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`)}<br><span class="muted">Not exact? Drag the pin or tap the right spot.</span>`
      : `<span class="muted">No location yet. Use the button above, search, or tap the map.</span>`;
  };
  const lookup = async () => {
    showSelected('Finding the address…');
    try {
      const p = await api(`/api/geo/reverse?lat=${pin.lat}&lng=${pin.lng}`);
      showSelected(p.label ? p.label.split(',').slice(0, 4).join(',') : '');
      if (p.area && !areaEdited) areaInput.value = p.area;
    } catch { showSelected(''); }
  };
  const map = L.map(el.querySelector('.lp-map'));
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const place = (lat, lng, zoom) => {
    pin = { lat, lng };
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); pin = { lat: p.lat, lng: p.lng }; lookup(); });
    }
    marker.setLatLng([lat, lng]);
    map.setView([lat, lng], zoom || Math.max(map.getZoom() || 0, 16));
  };
  map.on('click', (e) => { place(e.latlng.lat, e.latlng.lng); lookup(); });
  const start = pin || center || { lat: 12.9716, lng: 77.5946 }; // Bengaluru until we know better
  map.setView([start.lat, start.lng], pin ? 16 : center ? 13 : 11);
  if (pin) { place(pin.lat, pin.lng, 16); showSelected(area); } else showSelected();
  setTimeout(() => map.invalidateSize(), 100);

  q.oninput = () => {
    clearTimeout(timer);
    const text = q.value.trim();
    if (text.length < 3) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      results.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const list = await api('/api/geo/search?q=' + encodeURIComponent(text));
        results.innerHTML = list.map((p, i) => {
          const parts = p.label.split(',').map((x) => x.trim());
          return `<button type="button" class="secondary lp-r" data-i="${i}" style="display:block;text-align:left;width:100%;margin:4px 0;font-weight:normal">
            📍 <strong>${esc(parts[0])}</strong><br><span class="muted">${esc(parts.slice(1, 4).join(', '))}</span></button>`;
        }).join('') || '<p class="muted">No match. Try adding the city, e.g. "Whitefield, Bengaluru", or tap on the map.</p>';
        results.querySelectorAll('.lp-r').forEach((b) => b.onclick = () => {
          const p = list[b.dataset.i];
          results.innerHTML = ''; q.value = '';
          if (!areaEdited) areaInput.value = p.area;
          place(p.lat, p.lng, 16);
          showSelected(p.label.split(',').slice(0, 4).join(','));
        });
      } catch { results.innerHTML = ''; }
    }, 500);
  };
  el.querySelector('.lp-gps').onclick = () => {
    if (!navigator.geolocation) return toast('Location is not available on this device. Search or tap the map.');
    const b = el.querySelector('.lp-gps');
    b.disabled = true; b.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (p) => { b.disabled = false; b.textContent = `📍 ${here}`; place(p.coords.latitude, p.coords.longitude, 17); lookup(); },
      () => { b.disabled = false; b.textContent = `📍 ${here}`; toast('Could not get your location. Allow location access, or search / tap the map.'); },
      { enableHighAccuracy: true, timeout: 15000 });
  };
  return { value: () => ({ location: pin, area: areaInput.value.trim() }) };
}

// Opens a payment link: Pine Labs in a new tab, the test page in the same tab.
function openPayment(link, back = location.pathname) {
  if (!link) return;
  if (link.startsWith('/')) location.href = link + '&back=' + encodeURIComponent(back);
  else if (!window.open(link, '_blank')) location.href = link; // popup blocked
}
