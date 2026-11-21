'use strict';
/* Eventease web app. Talks to the same-origin REST API under /api. No build step. */
const $ = s => document.querySelector(s), act = {}, CN = { vip: 'VIP', std: 'Standard', con: 'Concession' }, EM = { Concert: '🎵', Theatre: '🎭', Sports: '🏅', Cultural: '🏮' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fm = n => 'S$' + (Math.round(n * 100) / 100).toFixed(Number.isInteger(+n) ? 0 : 2);
const fdt = d => new Date(d).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const sdt = d => new Date(d).toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short' });
const mem = {}, store = { get(k, s) { try { return (s ? sessionStorage : localStorage).getItem(k) } catch { return mem[k] || null } }, set(k, v, s) { try { (s ? sessionStorage : localStorage).setItem(k, v) } catch { mem[k] = v } }, del(k, s) { try { (s ? sessionStorage : localStorage).removeItem(k) } catch { delete mem[k] } } };
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
const S = { user: null, guest: store.get('ee_guest') || (store.set('ee_guest', rid()), store.get('ee_guest')), F: { q: '', cat: '', loc: '', date: '', max: 250 }, form: {}, all: null, ev: null, quote: null, busy: false, timers: [] };
const minPrice = e => Math.min(e.prices.vip, e.prices.std, e.prices.con), hue = id => (id * 47) % 360;
const tierOf = (e, s) => { const i = s.charCodeAt(0) - 65; return i < 2 ? 'vip' : i < e.rows - 1 ? 'std' : 'con' };
const IC = { ticket: '<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M9 10h6M9 14h6"/>', pin: '<path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>', cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>', check: '<path d="M5 12l5 5 9-10"/>', search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>', chev: '<path d="M6 9l6 6 6-6"/>', out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', chart: '<path d="M5 20V10M12 20V4M19 20v-7"/>', plus: '<path d="M12 5v14M5 12h14"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>' };
const ic = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n] || ''}</svg>`;
const ini = n => String(n || '?').trim().split(/[\s,]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const kd = d => { const x = new Date(d), o = { timeZone: 'Asia/Singapore' }; return `${x.toLocaleDateString('en-SG', { ...o, weekday: 'short' })} ${x.toLocaleDateString('en-SG', { ...o, day: 'numeric', month: 'short' })} · ${x.toLocaleTimeString('en-SG', { ...o, hour: 'numeric', minute: '2-digit' })}` };

async function api(path, o = {}) {
  const h = { 'Content-Type': 'application/json', 'X-Guest-Token': S.guest, 'X-EE-Request': '1' };
  if (o.requestId) h['Idempotency-Key'] = o.requestId;
  let r; try { r = await fetch('/api' + path, { method: o.method || 'GET', credentials: 'same-origin', headers: h, body: o.method && o.method !== 'GET' ? JSON.stringify(o.body || {}) : undefined }) } catch { throw Object.assign(new Error('Cannot reach the server. Check your connection and try again.'), { status: 0 }) }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong'), { status: r.status, code: d.code, data: d });
  return d;
}
const toast = m => { const t = $('#t'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 3500) };
const fail = e => { if (e.code === 'ORGANISER_APPROVAL_PENDING') return approvalPending(); if (e.status === 401 && S.user) { logout(true); return } toast(e.message) };
const clearTimers = () => { S.timers.forEach(clearInterval); S.timers = [] };


/* ---------- shell ---------- */
async function boot() {
  store.del('ee_tok'); store.del('ee_ot', 1);
  try { S.user = (await api('/session')).user } catch { S.user = null }
  applyUI(); route();
}
function chrome(p) {
  const u = S.user, L = [['home', 'Discover']];
  L.push(['find', 'Find my order']); if (u) L.push(['my', 'My tickets']);
  if (u && u.role === 'organiser') L.push(['org', 'Organiser'], ['gate', 'Gate scan']); if (u && u.role === 'admin') L.push(['admin', 'Admin']);
  const ff = document.getElementById('ffind'); if (ff) ff.hidden = false;
  $('#nav').innerHTML = L.map(l => `<a href="#${l[0]}" ${l[0] === p || (p === 'event' && l[0] === 'home') ? 'aria-current="page" class="on"' : ''}>${l[1]}</a>`).join('');
  const hq = document.querySelector('.hsearch input'); if (hq && document.activeElement !== hq) hq.value = S.F.q;
  const ml = u ? [...(u.role === 'organiser' ? [['org', 'Organiser dashboard', 'chart'], ['gate', 'Gate scan', 'scan']] : u.role === 'admin' ? [['admin', 'Platform overview', 'chart']] : []), ['my', 'My tickets', 'ticket'], ['profile', 'Profile and settings', 'user']] : [];
  $('#acct').innerHTML = u ? `<details class="menu"><summary aria-label="Account menu"><span class="avatar" aria-hidden="true">${esc(ini(u.name))}</span>${ic('chev', 16)}</summary><div class="menu-pop"><div class="menu-head"><span class="avatar lgav" aria-hidden="true">${esc(ini(u.name))}</span><div><b>${esc(u.name)}</b><small>${esc(u.role)} account</small></div></div>${ml.map(m => `<a href="#${m[0]}">${ic(m[2], 18)}${m[1]}</a>`).join('')}<button class="out" data-a="logout">${ic('out', 18)}Log out</button></div></details>` : '<a class="button-outline button-sm" href="#login">Log in</a><a class="button button-sm" href="#register">Create account</a>';
}
function route() {
  clearTimers(); stopCam(); const [p, a] = (location.hash.slice(1) || 'home').split('-'), pages = { home, event: evPage, my, order, find, org, admin, gate, login, register, profile, pending, apply: organiserApplication };
  chrome(pages[p] ? p : 'home'); const el = $('#app'); el.innerHTML = '<p class="mute">Loading...</p>';
  Promise.resolve((pages[p] || home)(a, S.user)).catch(e => { if (e.code === 'ORGANISER_APPROVAL_PENDING') return approvalPending(); if (e.status === 401) { S.user = null; store.del('ee_tok'); location.hash = 'login'; return } el.innerHTML = `<div class="box"><h2>Something went wrong</h2><p class="msg">${esc(e.message)}</p><button data-a="retry">Try again</button></div>` });
}
function need(role, u) { if (!u || (role && u.role !== role)) { $('#app').innerHTML = `<div class="box"><h2>${u ? 'Not available for your account' : 'Log in required'}</h2><p>${u ? `This page is for ${role} accounts.` : `Log in as ${role === 'admin' ? 'an administrator' : role === 'organiser' ? 'an organiser' : 'a customer'} to continue.`}</p>${u ? '' : '<p><a href="#login">Log in</a></p>'}</div>`; return true } }

/* ---------- accounts ---------- */
function login() {
  $('#app').innerHTML = `<div class="auth-card"><form data-form="login"><h1>Welcome back</h1><p class="mute">Log in to manage tickets, events or the platform.</p><label>Email<input name="email" type="email" required autocomplete="email"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label>
<div id="err" role="alert"></div><button class="b">Log in</button>
<div class="auth-links"><span class="mute">New to Eventease? <a href="#register">Create an account</a></span><span class="mute">Just buying tickets? <a href="#home">Continue as guest</a></span></div>
<div class="note">${ic('info', 16)}<span>One login for everyone. Organisers and admins see their tools after logging in.</span></div>
</form></div>`;
}
function register(a) {
  const og = a === 'organiser';
  $('#app').innerHTML = `<div class="auth-card"><form data-form="register"><h1>${og ? 'Create an organiser account' : 'Create your account'}</h1><p class="mute">${og ? 'Sell tickets for your own events. An administrator must approve your account before you can log in as an organiser. After approval, login requires a verification code sent to your email. ' : ''}Earn loyalty points, share a referral code and get SMS or WhatsApp alerts. Guests can still buy without an account.</p>${og ? `<p class="note">Already have a customer account? ${S.user?.role === 'customer' ? '<a href="#apply">Request organiser access</a>' : '<a href="#login">Log in</a> and request organiser access from Profile and settings'} using your existing account. You do not need to register the same email again.</p>` : ''}<label>Name<input name="name" required autocomplete="name"></label><label>Email<input name="email" type="email" required autocomplete="email"></label><label>Phone (for SMS or WhatsApp alerts)<input name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="\+?[0-9 ()\-]{8,20}" title="Phone number, for example +65 9123 4567" placeholder="+65 9123 4567"></label>
<label>Password (8+ characters)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label><label>I am a<select name="role"><option value="customer" ${og ? '' : 'selected'}>Customer</option><option value="organiser" ${og ? 'selected' : ''}>Event organiser (needs admin approval)</option></select></label>
<div id="err" role="alert"></div><button class="b">Create account</button><div class="auth-links"><span class="mute">Already have an account? <a href="#login">Log in</a></span></div></form></div>`;
}
function pending() {
  $('#app').innerHTML = `<section class="auth-card" aria-labelledby="approval-title"><span class="eyebrow">Organiser account</span><h1 id="approval-title">Approval pending</h1><p>Your organiser account is waiting for administrator approval. You cannot access organiser tools yet.</p><p>Once approved, log in again. We will send a verification code to your registered email address before opening your organiser dashboard.</p><p class="mute">If you need an update, contact the project administrator.</p><div class="auth-links"><a class="button" href="#login">Return to login</a><a href="#home">Browse events</a></div></section>`;
}
function approvalPending() { S.user = null; S.challengeId = null; S.form = {}; store.del('ee_tok'); location.hash = 'pending'; route() }
function organiserApplication(a, u) {
  if (need('customer', u)) return;
  $('#app').innerHTML = `<div class="auth-card"><form data-form="organiserRequest"><h1>Request organiser access</h1><p>This changes your customer account to an organiser account. Your existing account details and booking history are kept.</p><p>Submitting signs you out. An administrator must approve the request before you can log in again. After approval, we will send a login verification code to <b>${esc(u.email)}</b>.</p><p>Organiser accounts are for managing events. To buy tickets, use guest checkout.</p><label>Confirm your current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><div id="err" role="alert"></div><button class="b">Submit organiser request</button><p><a href="#profile">Back to profile</a></p></form></div>`;
}
async function authDone(r) { if (r.status === 'approval_pending' || r.code === 'ORGANISER_APPROVAL_PENDING') return approvalPending(); S.user = r.user; toast('Welcome, ' + r.user.name); location.hash = r.user.role === 'organiser' ? 'org' : r.user.role === 'admin' ? 'admin' : 'home'; route() }
async function logout(expired) { if (!expired) { try { await api('/auth/logout', {method:'POST'}) } catch (e) { toast(e.message); return } } S.user = null; S.form = {}; S.ev = null; store.del('ee_tok'); store.del('ee_ot',1); toast(expired ? 'Your session expired. Log in again.' : 'Logged out.'); location.hash = 'home'; route() }

/* ---------- browse ---------- */
const ph = e => `/img/ph-${['concert', 'theatre', 'sports', 'cultural'].includes(String(e.category).toLowerCase()) ? String(e.category).toLowerCase() : 'concert'}-${(+e.id || 0) % 4}.svg`;
async function home() {
  S.all = await api('/events'); const E = S.all, cs = Object.keys(EM), ls = [...new Set(E.map(e => e.location))].sort(), F = S.F, u = S.user;
  const hr = +new Date().toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false }) % 24, gr = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const chip = (v, t) => `<button class="category-chip" data-a="cat" data-v="${v}" aria-pressed="${F.cat === v}">${t}</button>`;
  $('#app').innerHTML = `<section class="greet"><h1>${u ? esc(gr + ', ' + u.name.split(/[ ,]/)[0]) : 'Find your next live event'}</h1><p>${u ? 'Browse live events and pick your exact seats.' : 'Concerts, theatre, sports and culture in Singapore. No account needed to buy, and QR tickets go straight to your phone.'}</p></section>
<div class="chip-bar"><div class="category-row" role="group" aria-label="Category">${chip('', 'All')}${cs.map(c => chip(c, c === 'Concert' ? 'Concerts' : c)).join('')}</div><div class="seg" role="group" aria-label="View"><button data-a="view" data-v="list" aria-pressed="${S.view !== 'cal'}">${ic('list', 16)} List</button><button data-a="view" data-v="cal" aria-pressed="${S.view === 'cal'}">${ic('cal', 16)} Calendar</button></div></div>
<div class="filter-bar"><label>Location<select data-f="loc"><option value="">All locations${ls.map(c => `<option ${F.loc === c ? 'selected' : ''}>${esc(c)}`).join('')}</select></label><label>On or after<input type="date" data-f="date" value="${esc(F.date)}"></label>
<label>Up to <output id="mo">S$${F.max}</output><input type="range" data-f="max" min="20" max="250" step="10" value="${F.max}" aria-label="Maximum price"></label></div>
<div class="section-title-row" id="events"><h2>Upcoming events</h2><span class="event-count" id="cnt" aria-live="polite"></span></div>
<div id="grid" class="grid"></div>
${S.user ? '' : '<section class="signup-banner"><div><span class="eyebrow">Member perks</span><h2>Earn points on every booking</h2><p>Create a free account for loyalty points and a referral code. Guests can still buy without one.</p></div><a class="button" href="#register">Create account</a></section>'}`;
  grid();
}
function grid() {
  const F = S.F, q = F.q.toLowerCase(), l = S.all.filter(e => (!q || (e.title + e.venue).toLowerCase().includes(q)) && (!F.cat || e.category === F.cat) && (!F.loc || e.location === F.loc) && (!F.date || e.startsAt.slice(0, 10) >= F.date) && minPrice(e) <= F.max);
  const c = $('#cnt'); if (c) c.textContent = `${l.length} event${l.length === 1 ? '' : 's'}`;
  const g = $('#grid'); g.classList.toggle('as-cal', S.view === 'cal'); if (S.view === 'cal') { g.innerHTML = cal(l); return }
  g.innerHTML = l.length ? l.map(e => `<a class="event-card" href="#event-${e.id}"><div class="event-visual g${e.id % 6}"><img class="ph" src="${ph(e)}" alt="" loading="lazy" decoding="async">${e.available === 0 ? '<span class="pill">Sold out</span>' : e.highDemand ? '<span class="pill">High demand</span>' : e.available < 15 ? `<span class="pill am">Only ${e.available} left</span>` : ''}</div>
<div class="event-card-body"><span class="event-kicker">${kd(e.startsAt)}</span><h3>${esc(e.title)}</h3><div class="event-location">${ic('pin', 14)}${esc(e.venue)}, ${esc(e.location)}</div>
<div class="event-card-bottom"><div><strong>From ${fm(minPrice(e))}</strong><small>per seat</small></div><span class="tag">${esc(e.category)}</span></div></div></a>`).join('') : '<div class="box"><h3>No events match</h3><p>Clear a filter or raise the maximum price.</p></div>';
}

/* ---------- event, seats, checkout ---------- */
async function evPage(id, u) {
  const v = S.ev = { id, d: null, mine: [], exp: null, resale: [] }; S.quote = null;
  try { await loadSeats() } catch (e) { if (e.code === 'QUEUE_REQUIRED') return waitingRoom(id); throw e }
  drawEvent(); await requote(); S.timers.push(setInterval(() => { if (!S.busy && !document.hidden && !document.querySelector('[data-pending]')) refresh().catch(() => { }) }, 8000), setInterval(tick, 1000));
}
async function loadSeats() { const v = S.ev, d = await api(`/events/${v.id}/seats`); v.d = d; v.mine = d.mine; v.exp = d.holdExpiresAt ? new Date(d.holdExpiresAt).getTime() : null; v.resale = d.resale }
async function refresh() { try { await loadSeats() } catch (e) { if (e.code === 'QUEUE_REQUIRED') return route(); throw e } drawMap(); if (!S.ev.mine.length) { S.quote = null; drawPanel() } }
async function requote() {
  const v = S.ev, f = S.form; if (!v.mine.length) { S.quote = null; return drawPanel() }
  try { S.quote = await api('/quote', { method: 'POST', body: { eventId: v.id, promoCode: f.promoOk || undefined, usePoints: !!f.usePts } }) } catch (e) { if (f.promoOk) { f.promoOk = ''; toast(e.message) } S.quote = null; try { S.quote = await api('/quote', { method: 'POST', body: { eventId: v.id } }) } catch { } }
  drawPanel();
}
const STEPS = ['Choose seats', 'Your details', 'Payment', 'Confirmed'];
const stepsHtml = n => `<div class="prog-wrap"><ol class="steps" aria-label="Ticket buying progress">${STEPS.map((t, i) => `<li class="${i + 1 < n ? 'done' : i + 1 === n ? 'on' : ''}" ${i + 1 === n ? 'aria-current="step"' : ''}><b>${i + 1 < n || n === 4 ? ic('check', 13) : i + 1}</b>${t}</li>`).join('')}</ol><div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${n * 25}" aria-label="Step ${n} of 4: ${STEPS[n - 1]}"><i style="width:${n * 25}%"></i></div><p class="prog-txt">Step ${n} of 4 &middot; ${STEPS[n - 1]}</p></div>`;
const stepNow = () => { const v = S.ev, u = S.user; if (!v || !v.mine.length) return 1; const g = id => (($(id) || {}).value ?? S.form[id.slice(1)] ?? '').trim(); return u || (g('#gn') && /^\S+@\S+\.\S+$/.test(g('#ge'))) ? 3 : 2 };
function refreshSteps() { const stp = $('#stp'); if (stp) stp.innerHTML = stepsHtml(stepNow()) }
const dkey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
function cal(l) {
  const now = new Date(), c = S.cm || (S.cm = (() => { const f = l.length ? new Date(l.slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0].startsAt) : now; return { y: +f.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(0, 4), m: +f.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' }).slice(5, 7) - 1 } })());
  const first = new Date(Date.UTC(c.y, c.m, 1)), days = new Date(Date.UTC(c.y, c.m + 1, 0)).getUTCDate(), off = first.getUTCDay(), by = {}, today = dkey(now);
  l.forEach(e => (by[dkey(e.startsAt)] = by[dkey(e.startsAt)] || []).push(e));
  const pad = n => String(n).padStart(2, '0'); let cells = '', cnt = 0;
  for (let i = 0; i < Math.ceil((off + days) / 7) * 7; i++) {
    const d = i - off + 1; if (d < 1 || d > days) { cells += '<div class="cd out"></div>'; continue }
    const k = `${c.y}-${pad(c.m + 1)}-${pad(d)}`, ev = (by[k] || []).sort((a, b) => a.startsAt.localeCompare(b.startsAt)); cnt += ev.length;
    cells += `<div class="cd ${k === today ? 'today' : ''}"><span class="dn">${d}</span>${ev.slice(0, 2).map(e => `<a class="ce g${e.id % 6}" href="#event-${e.id}" title="${esc(e.title)}">${new Date(e.startsAt).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit' })} ${esc(e.title)}</a>`).join('')}${ev.length > 2 ? `<span class="more">+${ev.length - 2} more</span>` : ''}</div>`;
  }
  const t = first.toLocaleDateString('en-SG', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  return `<div class="cal"><div class="cal-head"><button class="g button-sm" data-a="cm" data-v="-1" aria-label="Previous month">&lsaquo;</button><h3 aria-live="polite">${t}</h3><button class="g button-sm" data-a="cm" data-v="1" aria-label="Next month">&rsaquo;</button></div><div class="cal-grid" role="grid" aria-label="${t}">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(w => `<div class="cw" role="columnheader">${w}</div>`).join('')}${cells}</div>${cnt ? '' : '<p class="mute" style="text-align:center;margin:1rem 0 0">No events this month. Try the next one.</p>'}</div>`;
}
function drawEvent() {
  const e = S.ev.d.event;
  $('#app').innerHTML = `<nav class="crumbs" aria-label="Breadcrumb"><a href="#home">Discover</a><span>&rsaquo;</span><span>${esc(e.category)}</span><span>&rsaquo;</span><b>${esc(e.title)}</b></nav>
<div class="ev-banner g${e.id % 6}"><img class="ph" src="${ph(e)}" alt="">${e.status !== 'live' ? `<span class="pill am">${esc(e.status)}, not on sale</span>` : '<span class="pill">Public event</span>'}${e.highDemand ? '<span class="pill am">High demand</span>' : ''}</div>
<div class="ev-head"><h1>${esc(e.title)}</h1><div class="info-rows"><div class="info-row"><span class="info-ic">${ic('cal', 18)}</span><div><small>Date and time</small><span>${fdt(e.startsAt)}</span></div></div><div class="info-row"><span class="info-ic">${ic('pin', 18)}</span><div><small>Venue</small><span>${esc(e.venue)}, ${esc(e.location)}</span></div></div></div></div><div id="stp"></div>
<div class="two"><div class="box"><h2 style="margin-top:0">Choose your seats</h2><div class="live-dot">Live availability, refreshed every few seconds</div><div class="map" id="map"></div><div class="leg"><span><i></i>Available</span><span><i class="m">&#10003;</i>Your seat</span><span><i class="x">&times;</i>Taken</span><span><i class="h"></i>Held by another buyer</span><span><i class="wc">&#9855;</i>Wheelchair space</span></div><div id="resale"></div></div><aside class="pn" id="panel" aria-label="Your booking"></aside></div>`;
  drawMap(); drawPanel();
}
function drawMap() {
  const v = S.ev, d = v.d, e = d.event, sold = new Set(d.sold), held = new Set(d.held), mine = new Set(v.mine), el = $('#map'); if (!el) return; let rows = '', prev = '';
  const rg = {}; for (let i = 0; i < e.rows; i++) { const t = tierOf(e, String.fromCharCode(65 + i)); (rg[t] = rg[t] || []).push(String.fromCharCode(65 + i)) }
  for (let i = 0; i < e.rows; i++) {
    const r = String.fromCharCode(65 + i), tr = tierOf(e, r + '1'); if (tr !== prev) { prev = tr; const a = rg[tr]; rows += `<div class="tier-label ${tr === 'vip' ? 't0' : ''}"><span>${CN[tr]} &middot; Row${a.length > 1 ? 's ' + a[0] + '&ndash;' + a[a.length - 1] : ' ' + a[0]} &middot; ${fm(e.prices[tr])}</span></div>` }
    rows += `<div class="row"><b>${r}</b>`;
    for (let n = 1; n <= e.cols; n++) {
      const s = r + n, st = sold.has(s) ? 'x' : mine.has(s) ? 'm' : held.has(s) ? 'h' : '', t = tierOf(e, s), ac = i === e.rows - 1 && (n < 3 || n > e.cols - 2);
      rows += `<button class="s ${ac ? 'wc' : ''} ${st}" data-a="seat" data-v="${s}" aria-pressed="${st === 'm'}" aria-label="Row ${r} seat ${n}, ${CN[t]}, ${fm(e.prices[t])}, ${st === 'x' ? 'taken' : st === 'h' ? 'held by another buyer' : st === 'm' ? 'selected' : 'available'}${ac ? ', wheelchair space' : ''}" ${st === 'x' || st === 'h' || e.status !== 'live' ? 'disabled' : ''}>${st === 'x' ? '&times;' : st === 'm' ? ic('check', 14) : ac ? '&#9855;' : n}</button>`;
    }
    rows += '</div>';
  }
  el.innerHTML = `<div class="stage">Stage</div>${rows}`;
  const rs = $('#resale'); if (rs) rs.innerHTML = v.resale.length ? `<h3 style="margin-top:1rem">Verified resale tickets</h3>${v.resale.map(r => `<p>Seat ${esc(r.seat)} (${CN[tierOf(e, r.seat)]}) <b>${fm(r.price)}</b> <span class="mute">face value ${fm(r.face)}</span> ${window.EE?.resaleEnabled ? `<button class="b button-sm" data-a="buyrs" data-v="${r.id}">Buy</button>` : '<span class="mute">Resale is currently unavailable.</span>'}</p>`).join('')}` : '';
}
function drawPanel() {
  const v = S.ev, p = $('#panel'); if (!p) return; const e = v.d.event, u = S.user, f = S.form, q = S.quote, mine = v.mine, can = true;
  const keep = document.activeElement && document.activeElement.id;
  p.innerHTML = `<div class="pn-sec"><h3>Your seats</h3>${mine.length ? mine.map(s => { const t = tierOf(e, s); return `<div class="seat-chip"><div><b>Row ${esc(s[0])}, Seat ${esc(s.slice(1))}</b><small>${CN[t]} &middot; ${fm(e.prices[t])}</small></div><button class="x-btn" data-a="seat" data-v="${esc(s)}" aria-label="Remove seat ${esc(s)}">&times;</button></div>` }).join('') + '<span id="cd" class="timer"></span>' : `<p class="mute">Select seats on the map. Seats are held for you while you check out (up to ${v.d.maxSeats || 8}).</p>`}</div>
<div class="pn-sec"><h3>Order summary</h3><div class="tot"><span>Subtotal</span><b>${fm(q ? q.subtotal : 0)}</b></div>${q && q.discount ? `<div class="tot"><span>Discounts</span><b>-${fm(q.discount)}</b></div>` : ''}<div class="tot big"><span>Total</span><b>${fm(q ? q.total : 0)}</b></div>
<div class="assure">${ic('check', 16)}<span>No hidden charges. The price you see is the price you pay.</span></div></div>
${can ? `<div class="pn-sec"><div class="pr" style="margin-top:0"><input id="pc" placeholder="Promo or referral code" aria-label="Promo or referral code" value="${esc(f.pc || '')}"><button class="g" data-a="promo">Apply</button></div>
${u && u.points >= 10 ? `<label class="chk"><input type="checkbox" data-a="pts" ${f.usePts ? 'checked' : ''}> Use points (${u.points} available, 10 = S$1)</label>` : ''}
${u ? `<p class="mute">Tickets go to ${esc(u.email)}.</p>` : `<div class="f"><label>Name<input id="gn" autocomplete="name" value="${esc(f.gn || '')}"></label><label>Email<input id="ge" type="email" autocomplete="email" value="${esc(f.ge || '')}"></label><label>Phone (optional)<input id="gp" type="tel" autocomplete="tel" inputmode="tel" pattern="\+?[0-9 ()\-]{8,20}" title="Phone number, for example +65 9123 4567"  value="${esc(f.gp || '')}"></label></div><p class="mute">No account needed. Reopen tickets later with Find my order.</p>`}
<label>Payment<select id="pm">${(window.EE?.paymentMethods || []).map(m => `<option value="${esc(m)}" ${f.pm === m ? 'selected' : ''}>${m === 'stripe' ? 'Secure payment with Stripe' : m === 'card' ? 'Card (demo)' : 'PayNow (demo)'}</option>`).join('')}</select></label>${window.EE?.paymentMethods?.length ? '' : '<p class="msg">Payments are not configured. Please contact the organiser.</p>'}

<label>Alerts<select id="nc"><option value="email">Email only<option value="sms" ${f.nc === 'sms' ? 'selected' : ''}>SMS<option value="whatsapp" ${f.nc === 'whatsapp' ? 'selected' : ''}>WhatsApp</select></label>
<button class="b" data-a="pay" ${mine.length && e.status === 'live' && window.EE?.paymentMethods?.length ? '' : 'disabled'}>Pay ${fm(q ? q.total : 0)}</button></div>` : '<p class="mute">Organiser and admin accounts cannot book. Log out to buy as a guest.</p>'}`;
  refreshSteps();
  if (keep && $('#' + keep)) { const k = $('#' + keep); k.focus(); try { k.setSelectionRange(k.value.length, k.value.length) } catch { } } tick();
}
function tick() { const v = S.ev, c = $('#cd'); if (!c || !v || !v.mine.length || !v.exp) return; const m = v.exp - Date.now(); if (m <= 0) { toast('Your seat hold expired. Choose seats again.'); v.mine = []; v.exp = null; S.quote = null; refresh().then(drawPanel).catch(() => { }); return } c.textContent = `Held for ${Math.floor(m / 6e4)}:${String(Math.floor(m / 1e3) % 60).padStart(2, '0')}` }
async function waitingRoom(id) {
  const el = $('#app'), draw = r => { el.innerHTML = `<div class="box center"><span class="eyebrow">Waiting room</span><h2>You are in the queue</h2><p>This event is in high demand. We let buyers in batches so booking stays fast and fair. Keep this tab open.</p><h1>${r.ahead == null ? '' : r.ahead}</h1><p class="mute">people ahead of you</p><progress max="100" value="${Math.max(5, 100 - (r.ahead || 0))}"></progress></div>` };
  let r = await api(`/events/${id}/queue/join`, { method: 'POST' }); if (r.status === 'admitted' || r.status === 'open') return evPage(id, S.user); draw(r);
  S.timers.push(setInterval(async () => { try { r = await api(`/events/${id}/queue`); if (r.status === 'admitted' || r.status === 'open') { clearTimers(); evPage(id, S.user) } else draw(r) } catch (e) { fail(e) } }, 3000));
}
const buyer = () => { const u = S.user, g = id => ($(id) || {}).value || ''; return { paymentMethod: g('#pm') || S.form.pm || 'card', alertChannel: g('#nc') || 'email', buyer: u ? { phone: u.phone } : { name: g('#gn').trim(), email: g('#ge').trim(), phone: g('#gp').trim() } } };
async function holds(next) {
  if (S.busy) return; S.busy = true;
  try { const r = await api(`/events/${S.ev.id}/holds`, { method: 'PUT', body: { seats: next } }); S.ev.mine = r.seats; S.ev.exp = r.expiresAt ? new Date(r.expiresAt).getTime() : null; await loadSeats().catch(() => { }); drawMap(); await requote() }
  catch (e) { if (e.code === 'QUEUE_REQUIRED') route(); else { toast(e.message); await loadSeats().catch(() => { }); drawMap(); await requote() } } finally { S.busy = false }
}

/* ---------- orders and tickets ---------- */
function orderHtml(o, notes) {
  const t0 = o.tickets[0] || {};
  return `<div class="box"><div class="order-head"><div><h3>${esc(t0.eventTitle || 'Order')}</h3><p class="mute">${t0.startsAt ? fdt(t0.startsAt) + ', ' + esc(t0.venue) + '. ' : ''}Order #${esc(o.id)}, ${fm(o.total)}, ${esc(o.paymentMethod)}.</p></div><span class="st ${o.status === 'paid' ? 'ok' : 'bad'}">${esc(({paid:'Confirmed',pending_payment:'Payment pending',payment_failed:'Payment not completed',refund_pending:'Refund pending',cancelled:'Cancelled and refunded'})[o.status] || o.status)}</span></div>
${o.checkoutUrl ? `<p><a class="button" href="${esc(o.checkoutUrl)}">Continue secure payment</a></p>` : ''}
${o.tickets.map(t => { const v = t.status === 'valid' ? 'Valid' : t.status === 'used' ? 'Used' : t.status === 'reserved' ? 'Payment pending' : 'Void'; return `<div class="tk"><div class="tk-main"><span class="pill lt">${CN[t.tier]}</span> <span class="st ${v === 'Valid' ? 'ok' : 'bad'}">${v}</span><h4>Seat ${esc(t.seat)}</h4>
${v === 'Valid' ? (t.resale ? `<p>Listed for resale at ${fm(t.resale.price)} <button class="g button-sm" data-a="unlist" data-v="${t.resale.id}">Withdraw</button></p>` : `<div class="pr"><input id="t${t.id}" type="email" aria-label="Transfer to email" placeholder="Transfer to email"><button class="g" data-a="xfer" data-v="${t.id}">Transfer</button></div>${window.EE?.resaleEnabled ? `<div class="pr"><input id="r${t.id}" type="number" min="1" aria-label="Resale price" placeholder="Resale price, max ${fm(t.faceValue)}"><button class="g" data-a="resell" data-v="${t.id}">Resell</button></div>` : ''}`) : ''}</div>
<div class="tk-qr"><div class="qr" ${t.qr ? `data-c="${esc(t.qr)}"` : ''}>${t.qr ? esc(t.qr) : ''}</div>${t.qr ? `<code>${esc(t.qr)}</code>` : ''}</div></div>` }).join('')}
${o.status === 'paid' && o.tickets.some(t => t.status === 'valid') ? `<button data-a="cancel" data-v="${o.id}">Cancel order</button> <span class="mute">Refunds close shortly before the event. Transferred and resale tickets cannot be refunded.</span>` : ''}</div>`;
}
function qrs() { document.querySelectorAll('.qr[data-c]').forEach(el => { try { el.textContent = ''; new QRCode(el, { text: el.dataset.c, width: 96, height: 96 }) } catch { el.textContent = el.dataset.c } }) }
async function my(a, u) {
  if (need(null, u)) return; const [os, notes] = await Promise.all([api('/orders/mine'), api('/notifications')]); S.my = { os, notes }; drawMy();
}
function drawMy() {
  const u = S.user, { os, notes } = S.my, now = Date.now(), isUp = o => o.status === 'paid' && o.tickets.some(t => t.status === 'valid' && new Date(t.startsAt) >= now - 4 * 36e5), up = os.filter(isUp), past = os.filter(o => !isUp(o)), tab = S.tab === 'past' ? 'past' : 'up', list = tab === 'up' ? up : past;
  $('#app').innerHTML = `<div class="page-heading"><h1>Hi ${esc(u.name.split(/[ ,]/)[0])}, here&rsquo;s what&rsquo;s coming up</h1><p class="mute">Manage bookings, tickets and your history in one place.</p></div>
<div class="two"><div><div class="tabs" role="group" aria-label="Orders"><button data-a="tab" data-v="up" aria-pressed="${tab === 'up'}">Upcoming (${up.length})</button><button data-a="tab" data-v="past" aria-pressed="${tab === 'past'}">Past and cancelled (${past.length})</button></div>
${list.length ? list.map(o => orderHtml(o)).join('') : `<div class="box"><h3>${tab === 'up' ? 'No upcoming tickets' : 'Nothing here yet'}</h3><p><a href="#home"><b>Browse events</b></a> and pick your seats.</p></div>`}</div>
<aside><div class="box side-card"><div class="prof"><span class="avatar lgav" aria-hidden="true">${esc(ini(u.name))}</span><div><b>${esc(u.name)}</b><small>${esc(u.email || '')}</small></div></div><a class="button-outline button-sm" href="#profile">${ic('user', 16)} Edit profile and settings</a></div>
<div class="box"><h3>Loyalty and referrals</h3><p><b>${u.points || 0}</b> points (1 per S$10 spent, 10 points = S$1).</p><p class="mute">Your referral code <b>${esc(u.referral_code || '')}</b> gives friends 5% off. A qualifying verified first purchase of S$10 or more earns you 50 points after the event.</p></div>
<div class="box"><h3>Recent notifications</h3>${notes.slice(0, 6).map(n => `<p><b>${esc(n.channel)}</b>: ${esc(n.body)}</p>`).join('') || '<p class="mute">Nothing yet.</p>'}</div></aside></div>`; qrs();
}
async function order(id) {
  let o; try { o = await api('/orders/' + id) } catch (e) { if (e.status === 403 || e.status === 404) { toast('Open this order with Find my order.'); location.hash = 'find'; return } throw e }
  const fresh = String(S.justPaid) === String(id); S.justPaid = null;
  $('#app').innerHTML = `${fresh ? stepsHtml(4) : ''}<h2>Your order</h2>${S.user ? '' : '<p class="mute">Keep your order number. Reopening tickets requires a code sent to the buyer email.</p>'}${orderHtml(o)}`; qrs(); S.orderId = id; if (['pending_payment','refund_pending'].includes(o.status)) S.timers.push(setInterval(() => { if (!document.hidden) route() }, 5000));
}
function find() { $('#app').innerHTML = `<form class="box narrow" data-form="find"><h2>Find my order</h2><p class="mute">Enter your order number and buyer email. We will send a verification code.</p><label>Order number<input name="orderId" inputmode="numeric" required></label><label>Email<input name="email" type="email" required></label><div id="err" role="alert"></div><button class="b">Send verification code</button></form>` }
function verifyForm(challengeId, login = false) { S.challengeId = challengeId; if (login) { S.user = null; chrome('login') } $('#app').innerHTML = `<form class="box narrow" data-form="${login ? 'verifyLogin' : 'verifyOrder'}"><h2>Check your email</h2><p>If the details match, a code has been sent. It expires in 10 minutes.</p><label>Verification code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><div id="err" role="alert"></div><button class="b">Verify</button></form>` }
async function purchaseResult(r) {
  if (r.checkoutUrl) { const u = new URL(r.checkoutUrl); if (u.protocol !== 'https:' || u.hostname !== 'checkout.stripe.com') throw new Error('Invalid payment destination'); location.assign(u.href); return }
  S.form = {}; toast(r.order.status === 'paid' ? 'Payment successful. Your tickets are ready.' : 'Your order is being processed. Check its status shortly.');
  location.hash = 'order-' + r.order.id; route();
}

const reload = () => route();

/* ---------- organiser, admin, gate ---------- */
function editForm(e) {
  const loc = x => { const d = new Date(x), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }, lock = e.sold > 0 ? 'disabled' : '';
  return `<form class="box" data-form="editev" data-id="${e.id}"><h3>Edit event: ${esc(e.title)}</h3>${e.status === 'rejected' ? '<p class="msg">This event was rejected. Saving your changes sends it back to the admin for approval.</p>' : ''}<div class="f"><label>Title<input name="title" required value="${esc(e.title)}"></label><label>Category<select name="category">${Object.keys(EM).map(c => `<option ${c === e.category ? 'selected' : ''}>${c}`).join('')}</select></label><label>Date and time<input name="startsAt" type="datetime-local" required value="${loc(e.startsAt)}"></label>
<label>Venue name (the hall or building)<input name="venue" required value="${esc(e.venue)}"></label><label>Area (used by the location filter)<input name="location" required value="${esc(e.location)}"></label></div>
<div class="f" style="margin-top:.7rem"><label>VIP price (S$)<input name="priceVip" type="number" min="1" step="any" value="${e.prices.vip}" ${lock}></label><label>Standard price (S$)<input name="priceStd" type="number" min="1" step="any" value="${e.prices.std}" ${lock}></label><label>Concession price (S$)<input name="priceCon" type="number" min="1" step="any" value="${e.prices.con}" ${lock}></label><label>Seat rows<input name="rows" type="number" min="3" max="26" value="${e.rows}" ${lock}></label><label>Seats per row<input name="cols" type="number" min="1" max="30" value="${e.cols}" ${lock}></label></div>
${e.sold > 0 ? `<p class="mute">${e.sold} seat${e.sold === 1 ? ' is' : 's are'} already sold, so prices and the seat layout are locked. Title, date, venue and area can still change.</p>` : ''}<div data-err role="alert"></div><p><button class="b">Save changes</button> <button type="button" class="g" data-a="canceledit">Cancel</button></p></form>`;
}
async function org(a, u) {
  if (need('organiser', u)) return; if (!u.organiser_approved) { $('#app').innerHTML = '<div class="box center"><span class="eyebrow">Organiser</span><h2>Awaiting approval</h2><p>An administrator must approve your organiser account before you can create events.</p></div>'; return }
  const list = await api('/organiser/events'), sold = list.reduce((s, e) => s + e.sold, 0), rev = list.reduce((s, e) => s + +e.revenue, 0), live = list.filter(e => e.status === 'live').length, pend = list.filter(e => e.status === 'pending').length;
  S.orgList = list; const st = (n, v, s, i) => `<div class="stat-card"><span>${n}</span><span class="si">${ic(i, 18)}</span><strong>${v}</strong><small>${s}</small></div>`;
  $('#app').innerHTML = `<div class="dash-head"><div><h1>${esc(u.name)}</h1><p class="mute">Your events, sales and revenue at a glance.</p></div><button class="b" data-a="goc">${ic('plus', 16)} Create event</button></div>
<div class="stats-grid">${st('Events', list.length, live + ' live', 'cal')}${st('Seats sold', sold, 'across all events', 'ticket')}${st('Revenue', fm(rev), 'paid orders', 'chart')}${st('Pending approval', pend, 'awaiting an admin', 'clock')}</div>
<h2>Your events</h2><div class="etable"><div class="thead"><span>Event</span><span>Status</span><span>Tickets sold</span><span>Revenue</span></div>${list.map(e => `<div class="trow"><div class="tcell"><span class="thumb g${e.id % 6}"></span><div><b>${esc(e.title)}</b><small>${sdt(e.startsAt)} &middot; ${esc(e.venue)}</small></div></div><span><span class="status-badge status-${esc(e.status)}">${esc(e.status)}</span></span><div><small>${e.sold} / ${e.capacity}</small><div class="bar"><i style="width:${e.capacity ? Math.min(100, Math.round(e.sold * 100 / e.capacity)) : 0}%"></i></div></div><div><b>${fm(e.revenue)}</b> <button class="button-sm" data-a="edit" data-v="${e.id}">Edit</button></div></div>`).join('') || '<p class="mute" style="padding:1rem">No events yet. Create your first one below.</p>'}</div>
<div id="editbox"></div>
<form class="box" id="create" data-form="create"><h3>Create event</h3><div class="f"><label>Title<input name="title" required></label><label>Category<select name="category">${Object.keys(EM).map(c => `<option>${c}`).join('')}</select></label><label>Date and time<input name="startsAt" type="datetime-local" required></label><label>Venue name (the hall or building)<input name="venue" required placeholder="Esplanade Concert Hall"></label><label>Area (used by the location filter)<input name="location" required placeholder="Marina Bay"></label>
<label>VIP price (S$)<input name="priceVip" type="number" min="1" value="150"></label><label>Standard price (S$)<input name="priceStd" type="number" min="1" value="90"></label><label>Concession price (S$)<input name="priceCon" type="number" min="1" value="50"></label><label>Seat rows (A-B VIP, last row Concession)<input name="rows" type="number" min="3" max="26" value="8"></label><label>Seats per row<input name="cols" type="number" min="1" max="30" value="10"></label></div>
<div id="err" role="alert"></div><p><button class="b">Submit for approval</button></p></form>
${list.map(e => `<div class="box"><h3>${esc(e.title)} <span class="status-badge status-${esc(e.status)}">${esc(e.status)}</span></h3><p>${fdt(e.startsAt)}. Sold ${e.sold}/${e.capacity}, revenue ${fm(e.revenue)} (${e.tiers.map(t => `${CN[t.tier]} ${t.n}`).join(', ') || 'no sales yet'}).</p>
<div class="forecast"><b>Demand forecast:</b> about ${e.forecast.perDay} seats a day, projected ${e.forecast.projected}/${e.forecast.capacity} sold by show day. ${esc(e.forecast.advice)}</div>
${e.orders.length ? `<table><tr><th>Order<th>Buyer (masked)<th>Paid</tr>${e.orders.map(o => `<tr><td>#${esc(o.id)}<td>${esc(o.buyer)}<td>${fm(o.total)}</tr>`).join('')}</table>` : '<p class="mute">No orders yet.</p>'}</div>`).join('')}`;
}
async function admin(a, u) {
  if (need('admin', u)) return; const [sm, orgs, evs, fr, cfg, jobs] = await Promise.all([api('/admin/summary'), api('/admin/organisers'), api('/admin/events'), api('/admin/fraud'), api('/admin/settings'), api('/admin/payment-jobs')]);
  const st = (n, v, s, i) => `<div class="stat-card"><span>${n}</span><span class="si">${ic(i, 18)}</span><strong>${v}</strong><small>${s}</small></div>`;
  $('#app').innerHTML = `<div class="dash-head"><div><span class="adm-pill">Admin</span><span class="mute">${new Date().toLocaleDateString('en-SG', { timeZone: 'Asia/Singapore', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })}</span><h1>Platform overview</h1></div></div><div class="stats-grid">${st('Live events', sm.live_events, 'on sale', 'cal')}${st('Awaiting approval', sm.pending_events, 'events', 'list')}${st('Orders', sm.orders, 'paid', 'ticket')}${st('Booked', fm(sm.booked), 'total value', 'chart')}${st('Fraud flags', sm.open_flags, 'open', 'warn')}${st('Pending payments', sm.pending_payments || 0, 'pending or retrying', 'clock')}</div>
<div class="box"><h3>Event approvals <span class="status-badge status-pending">${evs.filter(e => e.status === 'pending').length} waiting</span></h3>${evs.filter(e => e.status === 'pending').map(e => `<div class="manage-item"><div><b>${esc(e.title)}</b><br><span class="mute">${fdt(e.startsAt)} &middot; ${esc(e.venue)}, ${esc(e.location)} &middot; ${e.rows * e.cols} seats from ${fm(e.prices.con)}</span></div><button class="b button-sm" data-a="evSt" data-v="${e.id}|live">Publish</button><button class="button-sm" data-a="evSt" data-v="${e.id}|rejected">Reject</button></div>`).join('') || '<p class="mute">No events are waiting for approval.</p>'}</div>
<div class="box"><h3>Organiser approvals</h3>${orgs.map(o => `<div class="manage-item"><div><b>${esc(o.name)}</b><br><span class="mute">${esc(o.email)}</span></div><span class="status-badge ${o.organiser_approved ? 'status-live' : 'status-pending'}">${o.organiser_approved ? 'Approved' : 'Pending'}</span>${o.organiser_approved ? '' : `<button class="b button-sm" data-a="apO" data-v="${o.id}">Approve</button>`}</div>`).join('') || '<p class="mute">No organisers.</p>'}</div>
<div class="box"><h3>All events</h3>${evs.filter(e => e.status !== 'pending').map(e => `<div class="manage-item"><div><b>${esc(e.title)}</b><br><span class="mute">${fdt(e.startsAt)}</span></div><span class="status-badge status-${esc(e.status)}">${esc(e.status)}</span>${e.status === 'pending' ? `<button class="b button-sm" data-a="evSt" data-v="${e.id}|live">Publish</button><button class="button-sm" data-a="evSt" data-v="${e.id}|rejected">Reject</button>` : ''}${e.status === 'live' ? `<button class="button-sm" data-a="hot" data-v="${e.id}|${e.highDemand ? 0 : 1}">${e.highDemand ? 'Waiting room on' : 'Waiting room off'}</button>` : ''}</div>`).join('')}</div>
<div class="box"><h3>Fraud monitor</h3>${fr.map(f => `<div class="manage-item"><div><b>${esc(f.kind)}</b><br><span class="mute">${esc(f.detail || '')} ${fdt(f.created_at)}</span></div><button class="button-sm" data-a="clr" data-v="${f.id}">Dismiss</button></div>`).join('') || '<p class="mute">No open flags. Rules: more than 6 seats in one order, 3 orders in 10 minutes, forged QR scans.</p>'}</div>
<div class="box"><h3>Payments and refunds</h3>${jobs.length ? jobs.map(j => `<p>Order #${esc(j.order_id)} &middot; ${esc(j.kind)} &middot; ${esc(j.last_error || 'Processing')} <small>${esc(j.id)}</small></p>`).join('') : '<p class="mute">No pending payments or refunds.</p>'}</div>
<div class="box"><h3>Notifications</h3><button data-a="remind">Send reminders for events in the next 3 days</button></div>
<form class="box" data-form="cfg"><h3>Platform settings</h3><div class="f"><label>Seat hold (minutes)<input name="hold_minutes" type="number" min="1" max="30" value="${cfg.hold_minutes}"></label><label>Refund cutoff (hours before event)<input name="refund_hours" type="number" min="0" value="${cfg.refund_hours}"></label><label>Max seats per order<input name="max_seats" type="number" min="1" max="20" value="${cfg.max_seats}"></label></div><p><button class="b">Save settings</button></p></form>`;
}
function profile(a, u) {
  if (need(null, u)) return; const PH = 'inputmode="tel" pattern="\\+?[0-9 ()\\-]{8,20}" title="Phone number, for example +65 9123 4567" placeholder="+65 9123 4567"';
  $('#app').innerHTML = `<div class="page-heading"><h1>Profile and settings</h1><p class="mute">Update how we contact you and keep your account secure.</p></div>
<div class="two"><div><form class="box" data-form="profile"><h3>Your details</h3><div class="f"><label>Name<input name="name" required autocomplete="name" value="${esc(u.name)}"></label><label>Email (cannot be changed)<input value="${esc(u.email)}" disabled></label><label>Phone (for SMS or WhatsApp alerts)<input name="phone" type="tel" autocomplete="tel" ${PH} value="${esc(u.phone || '')}"></label></div><div data-err role="alert"></div><p><button class="b">Save changes</button></p></form>
<form class="box" data-form="password"><h3>Change password</h3><div class="f"><label>Current password<input name="currentPassword" type="password" required autocomplete="current-password"></label><label>New password (8+ characters)<input name="newPassword" type="password" minlength="8" required autocomplete="new-password"></label></div><div data-err role="alert"></div><p><button class="b">Update password</button></p></form></div>
<aside><div class="box side-card"><div class="prof"><span class="avatar lgav" aria-hidden="true">${esc(ini(u.name))}</span><div><b>${esc(u.name)}</b><small style="text-transform:capitalize">${esc(u.role)} account</small></div></div></div>
<div class="box"><h3>Loyalty and referrals</h3><p><b>${u.points || 0}</b> points.</p><p class="mute">Your referral code <b>${esc(u.referral_code || '')}</b> gives friends 5% off. A qualifying verified first purchase of S$10 or more earns you 50 points after the event.</p></div>${u.role === 'customer' ? '<div class="box"><h3>Organise events</h3><p>Apply with your existing account. Administrator approval is required.</p><a class="button" href="#apply">Request organiser access</a></div>' : ''}<p><a class="back-link" href="#my">&lsaquo; Back to My tickets</a></p></aside></div>`;
}
let CAM = null;
function stopCam() { if (CAM) { CAM.stop = true; if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop()); CAM = null } const c = document.getElementById('cam'); if (c) c.hidden = true }
async function scanCode(code) {
  let r; try { r = await api('/gate/scan', { method: 'POST', body: { code } }) } catch (x) { if (!x.data || x.data.admit !== false) throw x; r = x.data }
  $('#res').innerHTML = r.admit ? `<div class="scan-res ok" role="status"><b>${ic('check', 22)} Admit</b><span>${esc(r.event)}, seat ${esc(r.seat)}</span></div>` : `<div class="scan-res bad" role="alert"><b>Do not admit</b><span>${esc(r.reason)}</span></div>`;
  if (navigator.vibrate) navigator.vibrate(r.admit ? 60 : [80, 60, 80]);
}
async function startCam() {
  stopCam(); const msg = $('#camMsg');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = 'This browser cannot open the camera (it needs HTTPS). Use manual entry below.'; return }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false }) } catch { msg.textContent = 'Camera is blocked. Allow camera access for this site in your browser, or use manual entry below.'; return }
  const vid = $('#vid'); vid.srcObject = stream; await vid.play(); $('#cam').hidden = false; msg.textContent = 'Hold the ticket QR code inside the frame.';
  const st = CAM = { stream, stop: false }; let det = null;
  if ('BarcodeDetector' in window) { try { det = new BarcodeDetector({ formats: ['qr_code'] }) } catch { } }
  if (!det && !window.jsQR) await new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = '/vendor/jsQR-1.4.0.js'; sc.onload = ok; sc.onerror = no; document.head.appendChild(sc) }).catch(() => { });
  if (!det && !window.jsQR) { msg.textContent = 'QR reading is not available in this browser. Use manual entry below.'; stopCam(); return }
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  const loop = async () => {
    if (st.stop) return; let code = null;
    try { if (vid.readyState >= 2) { if (det) { const r = await det.detect(vid); if (r.length) code = r[0].rawValue } else { cv.width = vid.videoWidth; cv.height = vid.videoHeight; cx.drawImage(vid, 0, 0); const im = cx.getImageData(0, 0, cv.width, cv.height), r = window.jsQR(im.data, im.width, im.height); if (r) code = r.data } } } catch { }
    if (code) { stopCam(); msg.textContent = 'Scanned. Checking...'; try { await scanCode(code) } catch (x) { fail(x) } msg.textContent = ''; const b = document.querySelector('[data-a=cam]'); if (b) b.textContent = 'Scan next ticket'; return }
    setTimeout(loop, 200);
  }; loop();
}
function gate(a, u) {
  if (need('organiser', u)) return;
  $('#app').innerHTML = `<div class="page-heading"><h1>Gate scan</h1><p class="mute">Point the camera at a ticket QR code. Valid tickets are admitted and marked used automatically. Scanning opens 2 hours before an event starts.</p></div>
<div class="two"><div class="box"><div class="cam" id="cam" hidden><video id="vid" playsinline muted></video><div class="reticle"></div></div><p id="camMsg" class="mute" aria-live="polite"></p><button class="b" data-a="cam" style="width:100%">${ic('scan', 18)} Start camera</button></div>
<div><div id="res" aria-live="polite"></div><details class="box"><summary><b>No camera? Enter the code manually</b></summary><form data-form="scan"><p class="mute">Type or paste the code printed under the QR.</p><div class="pr"><input name="code" aria-label="Ticket code" placeholder="EE.12.1.abc..." required><button class="b">Validate</button></div></form></details></div></div>`;
}

/* ---------- events (delegated) ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-a]'); if (!b || !act[b.dataset.a]) return; if (b.tagName === 'INPUT') return;
  b.setAttribute('data-pending', '1'); try { await act[b.dataset.a](b.dataset.v, b) } catch (x) { fail(x) } finally { b.removeAttribute('data-pending') }
});
document.addEventListener('change', e => { if (e.target.dataset.a === 'pts') { S.form.usePts = e.target.checked; requote() } if (e.target.id === 'pm') { S.form.pm = e.target.value; drawPanel() } if (e.target.id === 'nc') S.form.nc = e.target.value; if (e.target.dataset.f === 'cat' || e.target.dataset.f === 'loc') { S.F[e.target.dataset.f] = e.target.value; grid() } });
document.addEventListener('input', e => { const t = e.target, f = t.dataset.f; if (t.name === 'hq') { S.F.q = t.value; if ($('#grid')) grid(); return } if (/^(gn|ge|gp|pc|pt)$/.test(t.id)) { S.form[t.id] = t.value; if (/^g[ne]$/.test(t.id)) refreshSteps() } if (f && !/^(cat|loc)$/.test(f)) { S.F[f] = f === 'max' ? +t.value : t.value; if (f === 'max') $('#mo').textContent = 'S$' + S.F.max; grid() } });
document.addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]'); if (!form) return; e.preventDefault(); const d = Object.fromEntries(new FormData(form)), name = form.dataset.form;
  if (name === 'hsearch') { S.F.q = (d.hq || '').trim(); if ((location.hash.slice(1).split('-')[0] || 'home') !== 'home') location.hash = 'home'; else if ($('#grid')) grid(); return }
  const err = form.querySelector('[data-err]') || $('#err'), btn = form.querySelector('button.b'); if (err) err.textContent = ''; if (btn) btn.disabled = true;
  try {
    if (name === 'login') { const r = await api('/auth/login', { method:'POST', body:d }); if (r.challengeId) verifyForm(r.challengeId,true); else await authDone(r) }
    else if (name === 'register') { const r = await api('/auth/register',{method:'POST',body:d}); if (r.challengeId) verifyForm(r.challengeId,true); else await authDone(r) }
    else if (name === 'organiserRequest') { await authDone(await api('/me/organiser-request', {method:'POST',body:{currentPassword:d.currentPassword}})) }
    else if (name === 'find') { const r = await api('/orders/lookup', {method:'POST',body:d}); verifyForm(r.challengeId) }
    else if (name === 'verifyOrder') { const r = await api('/orders/verify', {method:'POST',body:{challengeId:S.challengeId,code:d.code}}); S.challengeId = null; location.hash = 'order-' + r.orderId }
    else if (name === 'verifyLogin') { await authDone(await api('/auth/verify', {method:'POST',body:{challengeId:S.challengeId,code:d.code}})); S.challengeId = null }
    else if (name === 'create') { d.startsAt = new Date(d.startsAt).toISOString(); await api('/organiser/events', { method: 'POST', body: d }); toast('Submitted. An admin must publish it.'); reload() }
    else if (name === 'cfg') { for (const k in d) d[k] = +d[k]; await api('/admin/settings', { method: 'PUT', body: d }); toast('Settings saved. No redeploy needed.') }
    else if (name === 'profile') { S.user = await api('/me', { method: 'PUT', body: { name: d.name, phone: d.phone } }); chrome('profile'); toast('Profile saved.') }
    else if (name === 'password') { await api('/me', { method: 'PUT', body: { name: S.user.name, phone: S.user.phone || '', currentPassword: d.currentPassword, newPassword: d.newPassword } }); form.reset(); S.user = null; location.hash = 'login'; toast('Password updated. Log in again.') }
    else if (name === 'editev') { const b = { ...d }; delete b.id; b.startsAt = new Date(d.startsAt).toISOString(); await api('/organiser/events/' + form.dataset.id, { method: 'PUT', body: b }); toast('Event updated.'); reload() }
    else if (name === 'scan') { await scanCode(d.code) }
  } catch (x) {
    if (x.code === 'ORGANISER_APPROVAL_PENDING') approvalPending();
    else {
      if (name === 'login' || name === 'verifyLogin') {
        try { S.user = (await api('/session')).user } catch { S.user = null }
        chrome('login');
      }
      if (err) err.innerHTML = `<p class="msg">${esc(x.message)}</p>`; else fail(x);
    }
  } finally { if (btn) btn.disabled = false }
});
addEventListener('hashchange', route);
document.addEventListener('click', e => { const m = document.querySelector('.menu[open]'); if (m && (!m.contains(e.target) || e.target.closest('a,[data-a]'))) m.removeAttribute('open') });
Object.assign(act, {
  retry: reload, logout: () => logout(), cam: () => startCam(), edit: id => { const e = (S.orgList || []).find(x => String(x.id) === String(id)); if (!e) return; const box = $('#editbox'); box.innerHTML = editForm(e); box.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, canceledit: () => { $('#editbox').innerHTML = '' }, view: v => { S.view = v; document.querySelectorAll('[data-a=view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v))); grid() }, cm: v => { const c = S.cm; c.m += +v; if (c.m < 0) { c.m = 11; c.y-- } if (c.m > 11) { c.m = 0; c.y++ } grid() }, tab: v => { S.tab = v; drawMy() }, goc: () => { const c = document.getElementById('create'); if (c) c.scrollIntoView({ behavior: 'smooth' }) },
  ts: v => setUI('ts', +v), hc: () => setUI('hc', !uiState().hc),
  cat: v => { S.F.cat = v; document.querySelectorAll('.category-chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.v === v))); grid() },
  go: () => { const e = document.getElementById('events'); if (e) e.scrollIntoView({ behavior: 'smooth' }) },
  seat: s => { const v = S.ev; if (S.user && S.user.role !== 'customer') return toast('Organiser and admin accounts cannot book. Log out to buy as a guest.'); const n = v.mine.includes(s) ? v.mine.filter(x => x !== s) : [...v.mine, s]; return holds(n) },
  promo: async () => { const c = ($('#pc').value || '').trim().toUpperCase(); S.form.pc = c; S.form.promoOk = c; await requote(); if (S.quote && S.quote.promo) toast('Code applied.'); else { S.form.promoOk = ''; if (c) toast('Code not recognised.') } },
  pay: async () => {
    if (S.paying) return; S.paying = true;
    try {
      const b = buyer(); b.eventId = S.ev.id; b.promoCode = S.form.promoOk || undefined; b.usePoints = !!S.form.usePts;
      const fingerprint = JSON.stringify(b); if (S.purchaseFingerprint !== fingerprint) { S.purchaseFingerprint = fingerprint; S.purchaseId = crypto.randomUUID() }
      const r = await api('/checkout', { method:'POST',body:b,requestId:S.purchaseId }); S.purchaseId = null; S.purchaseFingerprint = null; await purchaseResult(r);
    } finally { S.paying = false }
  },
  buyrs: async id => {
    if (S.paying) return; S.paying = true;
    try { const b = buyer(), fp = JSON.stringify([id,b]); if (S.purchaseFingerprint !== fp) { S.purchaseFingerprint = fp; S.purchaseId = crypto.randomUUID() } const r = await api(`/resale/${id}/buy`, {method:'POST',body:b,requestId:S.purchaseId}); S.purchaseId = null; S.purchaseFingerprint = null; await purchaseResult(r) } finally { S.paying = false }
  },
  cancel: async id => { const r = await api(`/orders/${id}/cancel`, { method:'POST' }); toast(r.pending ? 'Order cancelled. Your refund is being processed.' : `Refund completed: ${fm(r.refunded)}.`); reload() },
  xfer: async id => { const em = ($('#t' + id).value || '').trim(); if (!/^\S+@\S+\.\S+$/.test(em)) return toast('Enter a valid email to transfer to.'); await api(`/tickets/${id}/transfer`, { method: 'POST', body: { toEmail: em } }); toast('Transferred. The old QR no longer works.'); reload() },
  resell: async id => { await api(`/tickets/${id}/resale`, { method: 'POST', body: { price: +$('#r' + id).value } }); toast('Listed for resale. The QR stays valid until it sells.'); reload() },
  unlist: async id => { await api('/resale/' + id, { method: 'DELETE' }); reload() },
  apO: async id => { await api(`/admin/organisers/${id}/approve`, { method: 'POST' }); reload() },
  evSt: async v => { const [id, st] = v.split('|'); await api('/admin/events/' + id, { method: 'PATCH', body: { status: st } }); reload() },
  hot: async v => { const [id, on] = v.split('|'); await api('/admin/events/' + id, { method: 'PATCH', body: { highDemand: on === '1' } }); reload() },
  clr: async id => { await api(`/admin/fraud/${id}/resolve`, { method: 'POST' }); reload() },
  remind: async () => { const r = await api('/admin/reminders', { method: 'POST' }); toast(`${r.sent} reminders sent.`) }
});

const uiState = () => { try { return JSON.parse(store.get('ee_ui') || '{}') } catch { return {} } };
function setUI(k, v) { const u = uiState(); u[k] = v; store.set('ee_ui', JSON.stringify(u)); applyUI() }
function applyUI() { const u = uiState(), ts = +u.ts || 0, h = document.documentElement.classList; h.toggle('lg', ts === 1); h.toggle('xl', ts === 2); h.toggle('hc', !!u.hc);
  document.querySelectorAll('[data-a=ts]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === ts))); const c = document.querySelector('[data-a=hc]'); if (c) c.setAttribute('aria-pressed', String(!!u.hc)) }
boot();
