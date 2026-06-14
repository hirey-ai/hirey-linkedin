/* Hirey LinkedIn — a LinkedIn-style single-page client over the Hi REST API.
   No build step, no framework: a tiny hash router that renders cards from live Hi data. */

const app = document.getElementById('app');
const $ = (s, r = document) => r.querySelector(s);

// Mount point: the app may be served at "/" (local) or under "/{id}/demo/" (hosted). Routing is
// hash-based, so location.pathname is a stable base. Build all API URLs relative to it.
const MOUNT = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
const api = (p) => MOUNT + p;
let HOSTED = false; // learned from /api/health; in hosted mode we don't auto-create an identity
let SESSION = { logged_in: false, identity: null }; // hosted login state (browse anon; sign in to write)

// ---------------------------------------------------------------- tiny utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Scheme allow-list for any URL placed into href/src — esc() alone does NOT stop javascript:/data:.
const safeUrl = (u) => {
  try { const x = new URL(String(u ?? ''), location.href); return ['http:', 'https:', 'mailto:'].includes(x.protocol) ? x.href : '#'; }
  catch { return '#'; }
};

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const u = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
  for (const [label, sec] of u) if (s >= sec) return `${Math.floor(s / sec)}${label}`;
  return `${s}s`;
}

const AV_COLORS = ['#0a66c2', '#057642', '#915907', '#7a3e9d', '#b24020', '#1a7f8e', '#85661f', '#9b1c4b'];
function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}
function avatar(url, name, cls = '') {
  if (url) return `<img class="avatar ${cls}" src="${esc(safeUrl(url))}" alt="${esc(name)}" referrerpolicy="no-referrer"
                        onerror="this.outerHTML='<div class=\\'avatar ${cls}\\' style=\\'background:${colorFor(name)}\\'>${esc(initials(name))}</div>'" />`;
  return `<div class="avatar ${cls}" style="background:${colorFor(name)}">${esc(initials(name))}</div>`;
}
function publicIdFromUrl(u) {
  const m = String(u || '').match(/\/owner\/(\d+)/);
  return m ? Number(m[1]) : null;
}
function titleCase(s) {
  return String(s || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- Hi proxy
async function hi(capability, action, params = {}) {
  const r = await fetch(api('api/call'), {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability, action, params }),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j.result ?? j;
}
async function getFeed(limit = 24) {
  const r = await fetch(api(`api/feed?limit=${limit}`));
  const j = await r.json();
  return j.posts || [];
}

// ---------------------------------------------------------------- toast + modal
const toastEl = document.getElementById('toast');
let toastT;
function toast(msg, isErr = false) {
  toastEl.textContent = msg;
  toastEl.className = 'toast' + (isErr ? ' err' : '');
  toastEl.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (toastEl.hidden = true), 3200);
}

const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
const modalTitle = document.getElementById('modal-title');
document.getElementById('modal-close').onclick = closeModal;
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
function closeModal() { modal.hidden = true; modalBody.innerHTML = ''; }

// ---------------------------------------------------------------- login (hosted)
// Browse anonymously; any write requires signing in (Google / email / phone), which binds this
// browser's session agent to a recoverable Hi identity. Returns true if it intercepted (= not
// signed in yet, login modal opened), false if the caller may proceed.
function gateWrite(retry) {
  if (!HOSTED || SESSION.logged_in) return false;
  openLogin(retry);
  return true;
}

async function loginPost(path, body) {
  const r = await fetch(api('api/login/' + path), {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
}

async function afterLogin(onDone) {
  SESSION = { logged_in: true, identity: null };
  closeModal();
  toast('Signed in to Hi');
  await loadMe().catch(() => {});
  SESSION.identity = { email: ME?.bound_identities?.email || null, workspace_id: ME?.workspace_id || null };
  route();
  if (typeof onDone === 'function') onDone();
}

function openLogin(onDone) {
  modalTitle.textContent = 'Sign in to Hi';
  modalBody.innerHTML = `
    <p class="muted" style="margin:0 0 12px">Browse all you like. To <b>connect, message or post</b>, sign in — so your
      conversations are saved and you can pick up on any device.</p>
    <div class="login-tabs">
      <button class="login-tab active" data-m="google">Google</button>
      <button class="login-tab" data-m="email">Email</button>
      <button class="login-tab" data-m="phone">Phone</button>
    </div>
    <div id="login-pane"></div>`;
  modal.hidden = false;
  const panes = { google: googlePane, email: emailPane, phone: phonePane };
  const show = (m) => {
    modalBody.querySelectorAll('.login-tab').forEach((t) => t.classList.toggle('active', t.dataset.m === m));
    panes[m]($('#login-pane'), onDone);
  };
  modalBody.querySelectorAll('.login-tab').forEach((t) => (t.onclick = () => show(t.dataset.m)));
  show('google');
}

function googlePane(c, onDone) {
  c.innerHTML = `
    <button class="btn btn-primary btn-block" id="g-go">Continue with Google</button>
    <div id="g-status" class="login-status muted tiny"></div>`;
  $('#g-go', c).onclick = async () => {
    const st = $('#g-status', c); st.textContent = 'Opening Google…';
    let r;
    try { r = await loginPost('google/start', {}); } catch (e) { st.textContent = 'Could not start: ' + e.message; return; }
    if (!r.ok || !r.authorize_url) { st.textContent = 'Sign-in is unavailable right now.'; return; }
    const url = safeUrl(r.authorize_url);
    if (url === '#') { st.textContent = 'Got an invalid sign-in URL — try again.'; return; }
    const w = window.open(url, 'hi-google', 'noopener,noreferrer,width=500,height=680');
    st.innerHTML = `A Google window opened — approve there and you'll be signed in automatically.<br>
      <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Window blocked? Open sign-in &nearr;</a>`;
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      let res; try { res = await loginPost('google/poll', {}); } catch { res = {}; }
      if (res && res.status === 'verified') { clearInterval(iv); try { w && w.close(); } catch {} afterLogin(onDone); }
      else if (tries > 80) { clearInterval(iv); st.textContent = 'Timed out — click “Continue with Google” to try again.'; }
    }, 2500);
  };
}

function otpPane(c, onDone, opts) {
  // opts: { kind:'email'|'phone', cap, field, type, placeholder, label }
  c.innerHTML = `
    <input class="login-input" id="otp-id" type="${opts.type}" inputmode="${opts.kind === 'phone' ? 'tel' : 'email'}" placeholder="${opts.placeholder}" />
    <button class="btn btn-primary btn-block" id="otp-send">${opts.label}</button>
    <div id="otp-step2" hidden>
      <input class="login-input" id="otp-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" />
      <button class="btn btn-primary btn-block" id="otp-verify">Verify &amp; sign in</button>
    </div>
    <div id="otp-status" class="login-status muted tiny"></div>`;
  const st = $('#otp-status', c);
  $('#otp-send', c).onclick = async () => {
    const val = $('#otp-id', c).value.trim();
    if (!val) return (st.textContent = `Enter your ${opts.kind}.`);
    st.textContent = 'Sending code…';
    try {
      const r = await loginPost(`${opts.kind}/start`, { [opts.field]: val });
      if (!r.ok) { st.textContent = r.error === 'rate_limited' ? 'Too many attempts — wait a minute.' : `Couldn’t send a code — check your ${opts.kind}.`; return; }
      $('#otp-step2', c).hidden = false;
      st.textContent = `We sent a 6-digit code to ${val}. Enter it above.`;
    } catch (e) { st.textContent = 'Could not send: ' + e.message; }
  };
  $('#otp-verify', c).onclick = async () => {
    const code = $('#otp-code', c).value.trim();
    if (!/^\d{4,8}$/.test(code)) return (st.textContent = 'Enter the code from your ' + opts.kind + '.');
    st.textContent = 'Verifying…';
    try {
      const r = await loginPost(`${opts.kind}/verify`, { code });
      if (r.ok && r.logged_in) afterLogin(onDone);
      else st.textContent = 'That code didn’t work — try again.';
    } catch (e) { st.textContent = 'Verification failed: ' + e.message; }
  };
}
const emailPane = (c, onDone) => otpPane(c, onDone, { kind: 'email', field: 'email', type: 'email', placeholder: 'you@email.com', label: 'Email me a code' });
const phonePane = (c, onDone) => otpPane(c, onDone, { kind: 'phone', field: 'phone', type: 'tel', placeholder: '+1 415 555 0152', label: 'Text me a code' });

// Shown on Me / Messaging when browsing anonymously in the hosted app.
function renderSignInPrompt(what) {
  app.innerHTML = `<div class="grid-2">
    <div class="col"><div class="card empty">
      <div class="big">Sign in to see ${esc(what)}</div>
      <p class="muted" style="max-width:420px;margin:6px auto 16px">Browsing is open to everyone. Sign in with Google,
        email or phone to act as yourself — your profile, listings and conversations are saved and come back on any device.</p>
      <button class="btn btn-primary" data-login>Sign in to Hi</button>
    </div></div>
    <div class="col">${rightRail()}</div>
  </div>`;
}

// Reach out to an owner — opens a compose box and sends via hi.pairings.contact_owner.
function openCompose(person, listingId) {
  if (gateWrite(() => openCompose(person, listingId))) return;
  const name = person.display_name || 'this member';
  const pubId = person.owner_public_id || publicIdFromUrl(person.owner_public_url);
  modalTitle.textContent = `Message ${name}`;
  modalBody.innerHTML = `
    <div class="who">
      ${avatar(person.avatar_url, name, 'sm')}
      <div><div style="font-weight:600">${esc(name)}</div>
      <div class="muted tiny">${esc(person.headline || '')}</div></div>
    </div>
    <textarea id="cmp-text" placeholder="Write a note — say why you'd like to connect…">${
      listingId ? "Hi — I saw your listing on Hirey and would love to connect." : ''}</textarea>
    <div class="row">
      <button class="btn btn-ghost btn-sm" id="cmp-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="cmp-send">Send</button>
    </div>`;
  modal.hidden = false;
  $('#cmp-cancel').onclick = closeModal;
  $('#cmp-send').onclick = async () => {
    const text = $('#cmp-text').value.trim();
    if (!text) return toast('Write a message first', true);
    if (!pubId) return toast('This member can’t be reached', true);
    const btn = $('#cmp-send'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const params = { target_owner_public_id: pubId, text };
      if (listingId) params.listing_id = listingId;
      await hi('hi.pairings', 'contact_owner', params);
      closeModal();
      toast(`Message sent to ${name}`);
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Send';
      toast('Could not send: ' + e.message, true);
    }
  };
}

// Compose a "post" = publish a listing of what you're looking for.
function openPost() {
  if (gateWrite(() => openPost())) return;
  modalTitle.textContent = 'Start a post';
  modalBody.innerHTML = `
    <textarea id="post-text" placeholder="What are you looking for? e.g. “Hiring two senior Go engineers in Tokyo” or “Looking to meet AI founders in SF”."></textarea>
    <div class="row">
      <button class="btn btn-ghost btn-sm" id="post-cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="post-send">Post</button>
    </div>`;
  modal.hidden = false;
  $('#post-cancel').onclick = closeModal;
  $('#post-send').onclick = async () => {
    const text = $('#post-text').value.trim();
    if (text.length < 8) return toast('Add a little more detail', true);
    const btn = $('#post-send'); btn.disabled = true; btn.textContent = 'Posting…';
    try {
      await hi('hi.agent-listings', 'upsert', { text, status: 'published', visibility_status: 'public' });
      closeModal();
      toast('Your listing is live on Hi');
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Post';
      toast('Could not post: ' + e.message, true);
    }
  };
}

// ---------------------------------------------------------------- shared chrome
let ME = null; // workspace-overview result, fetched once

function railProfileCard() {
  const signedIn = !HOSTED || SESSION.logged_in;
  const name = ME?.current_name || (signedIn ? 'You on Hirey' : 'Guest');
  const sub = signedIn
    ? esc(SESSION.identity?.email || (ME?.bound ? 'Signed in' : 'Connected identity'))
    : 'Browsing anonymously';
  return `<div class="card profile-card">
    <div class="cover"></div>
    <div class="body">
      <a href="#/me">${avatar(null, name, 'lg avatar')}</a>
      <h2><a href="#/me">${esc(name)}</a></h2>
      <div class="muted tiny">${sub}</div>
    </div>
    ${signedIn
      ? `<div class="rail-stat"><span>Agents in workspace</span><b>${ME?.agents?.length ?? '–'}</b></div>`
      : `<button class="rail-link" data-login style="width:100%;text-align:left;background:none;border:0;border-top:1px solid var(--line);font:inherit;color:var(--blue);cursor:pointer">Sign in to act →</button>`}
    <a class="rail-link" href="#/network">Grow your network →</a>
  </div>`;
}

function rightRail() {
  const items = [
    ['Hi powers this feed', 'Every card is live from the Hi network API'],
    ['People you may know', 'Profile-scoped suggestions, refreshed each visit'],
    ['Reach out in one click', 'Connect opens a real 1:1 pairing on Hi'],
    ['Search the whole graph', 'Fuzzy, CJK-aware people + listing search'],
  ];
  return `<div class="card news">
    <h3>Hirey news</h3>
    <ul>${items.map(([t, d]) => `<li><div class="nt">${esc(t)}</div><div class="nd">${esc(d)}</div></li>`).join('')}</ul>
  </div>`;
}

// ---------------------------------------------------------------- views
function postCard(l) {
  const o = l.owner || {};
  const name = o.display_name || (o.is_anonymous ? 'Hirey member' : 'Hirey member');
  const pubId = publicIdFromUrl(o.owner_public_url);
  const text = l.preview_text || l.target_preview_text || l.text_head || '';
  const link = pubId ? `#/owner/${pubId}` : '#/';
  return `<article class="card post">
    <div class="head">
      <a href="${link}">${avatar(o.avatar_url, name)}</a>
      <div class="meta">
        <div class="name"><a href="${link}">${esc(name)}</a></div>
        <div class="sub">${esc(o.headline || titleCase(l.listing_type_id) || 'On Hirey')}</div>
        <div class="sub">${timeAgo(l.listing_created_at)} • 🌐 Public</div>
      </div>
    </div>
    ${l.listing_type_id ? `<span class="pill">${esc(titleCase(l.listing_type_id))}</span>` : ''}
    <div class="text">${esc(text)}</div>
    <div class="actions">
      <button data-act="like">👍 Like</button>
      <button data-act="profile" data-id="${pubId || ''}">👤 View profile</button>
      <button data-act="connect">🤝 Connect</button>
    </div>
  </article>`;
}

async function viewHome() {
  app.innerHTML = `<div class="grid-3">
    <div class="col">${railProfileCard()}</div>
    <div class="col">
      <div class="card composer">
        ${avatar(null, ME?.current_name || 'You', 'sm')}
        <button id="open-post">Start a post — tell Hi what you're looking for</button>
      </div>
      <div class="feed-divider">Latest from your network</div>
      <div id="feed"><div class="loading">Loading the feed…</div></div>
    </div>
    <div class="col">${rightRail()}</div>
  </div>`;
  $('#open-post').onclick = openPost;

  let posts = [];
  try { posts = await getFeed(24); } catch (e) { /* handled below */ }
  const feed = $('#feed');
  if (!feed) return;
  if (!posts.length) { feed.innerHTML = `<div class="card empty"><div class="big">Your feed is warming up</div>Try the search bar or “My Network”.</div>`; return; }
  feed.innerHTML = posts.map(postCard).join('');

  feed.querySelectorAll('.post').forEach((cardEl, i) => {
    const l = posts[i], o = l.owner || {};
    cardEl.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'like') { b.textContent = '👍 Liked'; b.style.color = 'var(--blue)'; }
        else if (act === 'profile') { const id = publicIdFromUrl(o.owner_public_url); if (id) location.hash = `#/owner/${id}`; }
        else if (act === 'connect') openCompose(o, l.listing_id);
      };
    });
  });
}

async function viewNetwork() {
  app.innerHTML = `<div class="grid-2">
    <div class="col">
      <div class="card">
        <div class="section-head"><h2>People you may know</h2></div>
        <div id="people" class="people-grid"><div class="loading">Finding people…</div></div>
      </div>
    </div>
    <div class="col">${railProfileCard()}${rightRail()}</div>
  </div>`;

  try {
    const res = await hi('hi.owners', 'peers_feed', { limit: 12 });
    const items = res.items || [];
    const grid = $('#people');
    if (!grid) return;
    if (!items.length) { grid.innerHTML = `<div class="empty">No suggestions yet — try searching.</div>`; return; }
    grid.innerHTML = items.map(personCard).join('');
    wirePeople(grid, items);
  } catch (e) {
    const grid = $('#people'); if (grid) grid.innerHTML = `<div class="empty">Couldn’t load suggestions.<br><span class="tiny">${esc(e.message)}</span></div>`;
  }
}

function personCard(p, why = true) {
  const name = p.display_name || 'Hirey member';
  const pubId = p.owner_public_id || publicIdFromUrl(p.owner_public_url);
  return `<div class="person">
    <div class="ptop"></div>
    <div class="pbody">
      <a href="${pubId ? `#/owner/${pubId}` : '#/'}">${avatar(p.avatar_url, name, 'lg')}</a>
      <div class="name"><a href="${pubId ? `#/owner/${pubId}` : '#/'}">${esc(name)}</a></div>
      <div class="head-l">${esc(p.headline || '')}</div>
      ${p.location_text ? `<div class="loc">📍 ${esc(p.location_text)}</div>` : ''}
      ${why && p.suggested_because ? `<div class="why">↳ ${esc(titleCase(p.suggested_because))}</div>` : ''}
      <button class="btn btn-outline btn-sm" data-connect>＋ Connect</button>
    </div>
  </div>`;
}
function wirePeople(grid, items) {
  grid.querySelectorAll('.person').forEach((node, i) => {
    const btn = node.querySelector('[data-connect]');
    if (btn) btn.onclick = () => openCompose(items[i]);
  });
}

async function viewSearch(q) {
  app.innerHTML = `<div class="grid-2">
    <div class="col">
      <div class="card">
        <div class="search-head">Results for <b>“${esc(q)}”</b></div>
        <div class="tabs"><span class="tab active" data-tab="people">People</span><span class="tab" data-tab="listings">Listings</span></div>
        <div id="results"><div class="loading">Searching the Hi network…</div></div>
      </div>
    </div>
    <div class="col">${railProfileCard()}${rightRail()}</div>
  </div>`;

  let data;
  try { data = await hi('hi.owners', 'search', { q, limit: 12 }); }
  catch (e) { $('#results').innerHTML = `<div class="empty">Search failed: ${esc(e.message)}</div>`; return; }

  const people = data.people || [];
  const listings = data.listings || [];
  const results = $('#results');
  const renderPeople = () => {
    if (!people.length) { results.innerHTML = `<div class="empty"><div class="big">No people matched “${esc(q)}”.</div>Try a name, role, or city.</div>`; return; }
    results.innerHTML = `<div class="people-grid">${people.map((p) => personCard(p, false)).join('')}</div>`;
    wirePeople($('.people-grid', results), people);
  };
  const renderListings = () => {
    if (!listings.length) { results.innerHTML = `<div class="empty">No listings matched “${esc(q)}”.</div>`; return; }
    results.innerHTML = listings.map(postCard).join('');
    results.querySelectorAll('.post').forEach((cardEl, i) => {
      const l = listings[i], o = l.owner || {};
      cardEl.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => {
          if (b.dataset.act === 'connect') openCompose(o, l.listing_id);
          else if (b.dataset.act === 'profile') { const id = publicIdFromUrl(o.owner_public_url); if (id) location.hash = `#/owner/${id}`; }
          else { b.textContent = '👍 Liked'; b.style.color = 'var(--blue)'; }
        };
      });
    });
  };
  renderPeople();
  app.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      app.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      t.dataset.tab === 'people' ? renderPeople() : renderListings();
    };
  });
}

async function viewProfile(pubId) {
  app.innerHTML = `<div class="grid-2"><div class="col"><div class="loading">Loading profile…</div></div><div class="col">${rightRail()}</div></div>`;
  let prof, listings = [];
  try {
    const g = await hi('hi.owners', 'get', { owner_public_id: Number(pubId) });
    prof = g.owner_profile || g.profile || g;
    const ll = await hi('hi.owners', 'list_listings', { owner_public_id: Number(pubId), limit: 10 }).catch(() => ({}));
    listings = ll.listings || ll.items || [];
  } catch (e) {
    app.innerHTML = `<div class="card empty"><div class="big">Profile unavailable</div>${esc(e.message)}</div>`;
    return;
  }
  const name = prof.display_name || 'Hirey member';
  const person = { display_name: name, headline: prof.headline, avatar_url: prof.avatar_url, owner_public_id: Number(pubId) };
  const links = [];
  if (prof.linkedin_url) links.push(`<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(prof.linkedin_url))}" target="_blank" rel="noopener noreferrer">in LinkedIn</a>`);
  if (prof.website_url) links.push(`<a class="btn btn-ghost btn-sm" href="${esc(safeUrl(prof.website_url))}" target="_blank" rel="noopener noreferrer">🔗 Website</a>`);
  if (prof.twitter_handle) links.push(`<a class="btn btn-ghost btn-sm" href="${esc(safeUrl('https://twitter.com/' + encodeURIComponent(prof.twitter_handle)))}" target="_blank" rel="noopener noreferrer">𝕏 ${esc(prof.twitter_handle)}</a>`);

  app.innerHTML = `<div class="grid-2">
    <div class="col">
      <div class="card hero">
        <div class="cover"></div>
        <div class="hbody">
          ${avatar(prof.avatar_url, name, 'xl')}
          <h1>${esc(name)}</h1>
          <div class="h-headline">${esc(prof.headline || '')}</div>
          ${prof.location_text ? `<div class="h-loc">📍 ${esc(prof.location_text)}</div>` : ''}
          <div class="h-actions">
            <button class="btn btn-primary" id="p-connect">＋ Connect</button>
            <button class="btn btn-outline" id="p-msg">Message</button>
            ${links.join('')}
          </div>
        </div>
      </div>
      ${prof.bio_markdown ? `<div class="card about"><div class="pad"><h2 style="margin:0;font-size:18px">About</h2><p>${esc(prof.bio_markdown)}</p></div></div>` : ''}
      <div class="card">
        <div class="section-head"><h2>Listings</h2></div>
        ${listings.length ? listings.map((l) => `
          <div class="listing-row">
            <div class="dot"></div>
            <div>
              <div class="lt">${esc(titleCase(l.listing_type_id))} • ${esc(l.status || 'open')} • ${timeAgo(l.created_at || l.listing_created_at)}</div>
              <div>${esc(l.summary || l.text_head || l.preview_text || '')}</div>
            </div>
          </div>`).join('') : `<div class="empty tiny">No public listings.</div>`}
      </div>
    </div>
    <div class="col">${railProfileCard()}${rightRail()}</div>
  </div>`;
  $('#p-connect').onclick = () => openCompose(person);
  $('#p-msg').onclick = () => openCompose(person);
}

async function viewMessaging() {
  if (HOSTED && !SESSION.logged_in) return renderSignInPrompt('your messages');
  app.innerHTML = `<div class="card"><div class="msg-wrap">
    <div class="thread-list" id="threads"><div class="loading">Loading…</div></div>
    <div class="thread-pane" id="pane"><div class="empty">Select a conversation</div></div>
  </div></div>`;
  let pairings = [];
  try { const r = await hi('hi.pairings', 'list', { list_limit: 30 }); pairings = r.pairings || r.items || []; }
  catch (e) { $('#threads').innerHTML = `<div class="empty tiny">${esc(e.message)}</div>`; return; }

  const threads = $('#threads');
  if (!pairings.length) {
    threads.innerHTML = `<div class="empty"><div class="big">No conversations yet</div><span class="tiny">Connect with someone from the feed to start a thread.</span></div>`;
    return;
  }
  threads.innerHTML = pairings.map((pr, i) => `
    <div class="thread-item" data-i="${i}">
      ${avatar(null, pr.counterpart_display_name || pr.counterpart_agent_id || 'Member', 'sm')}
      <div><div class="name">${esc(pr.counterpart_display_name || 'Hi member')}</div>
      <div class="muted tiny">${esc((pr.last_message_preview || pr.pairing_kind || 'Conversation')).slice(0, 48)}</div></div>
    </div>`).join('');

  threads.querySelectorAll('.thread-item').forEach((node) => {
    node.onclick = async () => {
      threads.querySelectorAll('.thread-item').forEach((x) => x.classList.remove('active'));
      node.classList.add('active');
      const pr = pairings[node.dataset.i];
      const pane = $('#pane');
      pane.innerHTML = `<div class="loading">Loading messages…</div>`;
      try {
        const t = await hi('hi.pairings', 'timeline', { pairing_id: pr.pairing_id, chats_limit: 50 });
        const msgs = t.chats || t.messages || t.timeline || [];
        const mine = pr.viewer_side;
        pane.innerHTML = `<div class="bubbles">${
          (msgs.length ? msgs : []).map((m) => {
            const isMe = (m.side && m.side === mine) || m.is_self || m.from_self;
            return `<div class="bubble ${isMe ? 'me' : 'them'}">${esc(m.text || m.body || m.content || '')}</div>`;
          }).join('') || '<div class="empty tiny">No messages in this thread yet.</div>'
        }</div>`;
      } catch (e) { pane.innerHTML = `<div class="empty tiny">${esc(e.message)}</div>`; }
    };
  });
}

async function viewMe() {
  if (HOSTED && !SESSION.logged_in) return renderSignInPrompt('your profile & workspace');
  app.innerHTML = `<div class="grid-2"><div class="col"><div class="loading">Loading your workspace…</div></div><div class="col">${rightRail()}</div></div>`;
  let r;
  try { r = await hi('hi.workspace-overview', 'get'); } catch (e) { app.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  const agents = r.agents || [];
  const cur = agents.find((a) => a.is_current) || agents[0] || {};
  const name = cur.display_name || 'You on Hirey';
  app.innerHTML = `<div class="grid-2">
    <div class="col">
      <div class="card hero">
        <div class="cover"></div>
        <div class="hbody">
          ${avatar(null, name, 'xl')}
          <h1>${esc(name)}</h1>
          <div class="h-headline">${r.bound ? 'Connected Hirey identity' : 'Anonymous Hi agent'} · ${esc(r.summary || '')}</div>
          ${r.bound_identities?.phone_e164 ? `<div class="h-loc">📱 ${esc(r.bound_identities.phone_e164)}</div>` : ''}
        </div>
      </div>
      <div class="card">
        <div class="section-head"><h2>Your agents / devices</h2></div>
        ${agents.map((a) => `
          <div class="listing-row">
            <div class="dot" style="background:${a.is_current ? 'var(--green)' : 'var(--blue)'}"></div>
            <div>
              <div>${esc(a.display_name || a.agent_id)} ${a.is_current ? '<span class="pill">This device</span>' : ''}</div>
              <div class="lt">${esc(a.status || '')} • ${a.listing_count ?? 0} listings • active ${timeAgo(a.last_active)}</div>
            </div>
          </div>`).join('') || '<div class="empty tiny">No agents.</div>'}
      </div>
    </div>
    <div class="col">${rightRail()}</div>
  </div>`;
}

// ---------------------------------------------------------------- router
async function loadMe() {
  try {
    const r = await hi('hi.workspace-overview', 'get');
    const cur = (r.agents || []).find((a) => a.is_current) || (r.agents || [])[0] || {};
    ME = { ...r, current_name: cur.display_name };
    const av = document.getElementById('nav-avatar');
    if (av) { av.textContent = initials(cur.display_name || 'Hi'); av.style.background = colorFor(cur.display_name || 'Hi'); }
  } catch { /* keep defaults */ }
}

function setActiveNav(name) {
  document.querySelectorAll('#navlinks a').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === name));
}

async function route() {
  const hash = location.hash || '#/';
  closeModal();
  window.scrollTo(0, 0);
  if (hash.startsWith('#/owner/')) { setActiveNav(''); return viewProfile(hash.split('/')[2]); }
  if (hash.startsWith('#/search')) {
    setActiveNav('');
    const q = new URLSearchParams(hash.split('?')[1] || '').get('q') || '';
    $('#nav-search-input').value = q;
    return viewSearch(q);
  }
  if (hash.startsWith('#/network')) { setActiveNav('network'); return viewNetwork(); }
  if (hash.startsWith('#/messaging')) { setActiveNav('messaging'); return viewMessaging(); }
  if (hash.startsWith('#/me')) { setActiveNav('me'); return viewMe(); }
  setActiveNav('home');
  return viewHome();
}

document.getElementById('nav-search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#nav-search-input').value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

window.addEventListener('hashchange', route);

// any element with a [data-login] attribute opens the sign-in modal
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-login]');
  if (t) { e.preventDefault(); openLogin(() => route()); }
});

// Boot: learn the mode + (hosted) the login state. In hosted mode browsing is anonymous; an
// identity is only resolved once the visitor has signed in (Google / email / phone).
(async () => {
  try { HOSTED = (await (await fetch(api('api/health'))).json()).hosted === true; } catch { /* default local */ }
  if (HOSTED) {
    try { SESSION = await (await fetch(api('api/session'))).json(); } catch { /* logged_in stays false */ }
  }
  if (!HOSTED || SESSION.logged_in) await loadMe().catch(() => {});
  route();
})();
