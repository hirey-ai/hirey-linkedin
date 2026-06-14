#!/usr/bin/env node
// Hirey LinkedIn — zero-dependency static server + authenticated proxy to the Hi REST API.
//
// Two run modes:
//   • local (default): one anonymous Hi agent for everything — `npm start`, you act as yourself.
//   • hosted (HOSTED=1): a public multi-tenant deployment. Read-only calls (feed / search /
//     people / profiles) go through one shared service agent, so passive visitors and crawlers
//     never mint an identity. The moment a visitor *acts* (connect / message / post / open
//     Messaging or Me), a fresh anonymous Hi agent is provisioned for THAT browser session
//     (cookie-keyed) — so everyone acts as their own isolated identity, with no shared inbox.
//
// Either way the browser never sees a secret; the server injects the bearer token.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const HI_BASE = (process.env.HI_BASE_URL || 'https://hi.hirey.ai').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 4173);
const HOSTED = process.env.HOSTED === '1';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://hub.hirey.ai (hosted CSRF allowlist)
const CREDS_DIR = join(homedir(), '.config', 'hirey-linkedin');
const CREDS_PATH = join(CREDS_DIR, 'credentials.json');

// Capabilities + actions the browser may invoke. Actions tagged READ go through the shared
// service agent; everything else provisions / uses the per-session agent in hosted mode.
const READ = new Set([
  'hi.owners:get', 'hi.owners:search', 'hi.owners:peers_feed', 'hi.owners:list_listings',
  'hi.agent-listings:browse_recent', 'hi.agent-listings:list', 'hi.agent-listings:get',
  'hi.matching-sessions:match_feed', 'hi.public-pages:get',
]);
const WRITE = new Set([
  'hi.owners:update_profile', 'hi.owners:list_agents',
  'hi.agent-listings:upsert',
  'hi.workspace-overview:get',
  'hi.pairings:list', 'hi.pairings:timeline', 'hi.pairings:create',
  'hi.pairings:contact_owner', 'hi.pairings:contact_target',
  // login / identity binding — turns the anonymous session agent into a recoverable identity
  'hi.phone-binding:bind', 'hi.phone-binding:verify',
  'hi.email-binding:bind', 'hi.email-binding:verify',
  'hi.google-link:start', 'hi.google-link:poll',
]);

// A successful bind/verify (or google poll → verified) means this session is now signed in.
function detectLogin(capability, action, params, result) {
  if (!result) return null;
  const verified =
    ((capability === 'hi.phone-binding' || capability === 'hi.email-binding') && action === 'verify' && result.workspace_id) ||
    (capability === 'hi.google-link' && action === 'poll' && result.status === 'verified');
  if (!verified) return null;
  // Only surface what Hi actually verified — never echo client-supplied params as "identity".
  return {
    workspace_id: result.workspace_id || null,
    email: result.email || null,
    phone: result.phone_e164 || null,
    joined_existing: result.joined_existing_workspace ?? null,
    agents_in_workspace: result.agents_in_workspace ?? null,
  };
}
const isAllowed = (cap, action) => READ.has(`${cap}:${action}`) || WRITE.has(`${cap}:${action}`);
const isRead = (cap, action) => READ.has(`${cap}:${action}`);

// ----------------------------------------------------------------------------- identity
// An AgentCtx holds one Hi agent's credentials + a cached access token.
class AgentCtx {
  constructor(creds) { this.creds = creds; this.token = { value: null, exp: 0 }; this.lastSeen = Date.now(); this.bound = false; this.identity = null; }
  async getToken() {
    const now = Date.now();
    if (this.token.value && this.token.exp - now > 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.creds.client_id,
      client_secret: this.creds.client_secret,
      audience: 'hirey-hi',
    });
    const res = await fetch(`${HI_BASE}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
    const j = await res.json();
    this.token = { value: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
    return this.token.value;
  }
  async call(capability, action, params = {}) {
    const tok = await this.getToken();
    const res = await fetch(`${HI_BASE}/v1/capabilities/${capability}/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { error: 'bad_upstream_json', raw: text.slice(0, 500) }; }
    return { status: res.status, json };
  }
}

async function registerAgent(label, persist) {
  const res = await fetch(`${HI_BASE}/v1/agents/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'Hirey LinkedIn', agent_kind: 'external', metadata: { host: label } }),
  });
  if (!res.ok) throw new Error(`agent register failed: ${res.status}`);
  const j = await res.json();
  const c = { client_id: j.auth.client_id, client_secret: j.auth.client_secret, agent_id: j.agent.agent_id, installation_id: j.installation.installation_id };
  if (persist) {
    await mkdir(CREDS_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CREDS_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  }
  return c;
}

async function activate(ctx) {
  try {
    const tok = await ctx.getToken();
    await fetch(`${HI_BASE}/v1/agents/activate`, {
      method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}',
    });
  } catch { /* non-fatal */ }
}

// The shared service agent (reads, + everything in local mode).
async function loadServiceCreds() {
  if (process.env.HI_CLIENT_ID && process.env.HI_CLIENT_SECRET) {
    return { client_id: process.env.HI_CLIENT_ID, client_secret: process.env.HI_CLIENT_SECRET, agent_id: process.env.HI_AGENT_ID || null };
  }
  if (existsSync(CREDS_PATH)) {
    try { const c = JSON.parse(await readFile(CREDS_PATH, 'utf8')); if (c.client_id && c.client_secret) return c; } catch { /* re-register */ }
  }
  return registerAgent('hirey-linkedin', true);
}

let serviceCtx = null;

// Per-browser agents (hosted mode). Cookie hl_sid -> AgentCtx. An agent is minted ONLY when a
// visitor actually starts signing in (google_link/*-binding) or writes — never on plain browsing,
// which uses the shared service agent. The cookie is long-lived so a returning browser REUSES its
// one agent instead of minting a new one each visit; idle/abandoned anonymous agents are reaped by
// Hi's own idle-agent cleanup. Net: ~1 agent per browser that signs in, not 1 per visit.
const sessions = new Map();
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30d — reuse one agent per browser across visits
const MAX_SESSIONS = 20000;
const SID_RE = /^[a-f0-9]{32}$/;
const newSid = () => randomBytes(16).toString('hex');
const sessionCookie = (sid) => `hl_sid=${sid}; Path=/; HttpOnly;${HOSTED ? ' Secure;' : ''} SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`;

function sweepSessions() {
  const now = Date.now();
  for (const [sid, ctx] of sessions) if (now - ctx.lastSeen > SESSION_TTL) sessions.delete(sid);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, sessions.size - MAX_SESSIONS);
    for (const [sid] of oldest) sessions.delete(sid);
  }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

// ---- abuse control: per-IP token buckets (anonymous clients can mint Hi agents + send OTPs) ----
const buckets = new Map(); // ip -> { mint:[ts], otp:[ts] }
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'; }
function rateOk(ip, bucket, max, windowMs) {
  const now = Date.now();
  if (buckets.size > 5000) buckets.clear(); // crude bound; resets counters, acceptable for a demo
  let e = buckets.get(ip); if (!e) { e = {}; buckets.set(ip, e); }
  const arr = (e[bucket] = (e[bucket] || []).filter((t) => now - t < windowMs));
  if (arr.length >= max) return false;
  arr.push(now); return true;
}

// Resolve which agent handles this call. Reads use the shared service agent; writes use a
// per-session agent keyed by a SERVER-MINTED sid. A client-supplied sid is honoured only if it
// already maps to a live session — an unknown value is never adopted (anti session-fixation).
// Returns { ctx, sid } so the caller can rotate the sid at the login (privilege) boundary.
async function ctxFor(req, capability, action, setCookie) {
  if (!HOSTED || isRead(capability, action)) { serviceCtx.lastSeen = Date.now(); return { ctx: serviceCtx, sid: null }; }
  const incoming = parseCookies(req).hl_sid;
  let sid = (incoming && SID_RE.test(incoming) && sessions.has(incoming)) ? incoming : null;
  let ctx = sid ? sessions.get(sid) : null;
  if (!ctx) {
    sweepSessions();
    sid = newSid(); // mint our own; do NOT trust the client's value
    ctx = new AgentCtx(await registerAgent('hirey-linkedin-session', false));
    await activate(ctx);
    sessions.set(sid, ctx);
    setCookie(sessionCookie(sid));
  }
  ctx.lastSeen = Date.now();
  return { ctx, sid };
}

// ----------------------------------------------------------------------------- feed
const FEED_SEEDS = ['founder', 'engineer', 'designer', 'investor', 'hiring', 'startup', 'remote', 'product manager', 'AI', 'marketing', 'data', 'growth'];
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function buildFeed(limit = 20) {
  const seeds = shuffle(FEED_SEEDS).slice(0, 5);
  const seen = new Map();
  const batches = await Promise.all(seeds.map((q) => serviceCtx.call('hi.owners', 'search', { q, limit: 8 }).catch(() => null)));
  for (const b of batches) for (const l of (b?.json?.result?.listings || [])) if (l.listing_id && !seen.has(l.listing_id)) seen.set(l.listing_id, l);
  return [...seen.values()].sort((a, b) => new Date(b.listing_created_at || 0) - new Date(a.listing_created_at || 0)).slice(0, limit);
}

// ----------------------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
  res.end(JSON.stringify(body));
}
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks).toString('utf8'); }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, hosted: HOSTED, agent_id: HOSTED ? null : (serviceCtx?.creds?.agent_id || null), hi_base: HI_BASE });
    }

    // passive login-state check (does NOT provision an agent)
    if (p === '/api/session') {
      if (!HOSTED) return sendJson(res, 200, { hosted: false, logged_in: true });
      const sid = parseCookies(req).hl_sid;
      const ctx = sid ? sessions.get(sid) : null;
      if (ctx && ctx.bound) { ctx.lastSeen = Date.now(); return sendJson(res, 200, { hosted: true, logged_in: true, identity: ctx.identity }); }
      return sendJson(res, 200, { hosted: true, logged_in: false });
    }

    if (p === '/api/feed') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 40);
      return sendJson(res, 200, { ok: true, posts: await buildFeed(limit) });
    }

    if (p === '/api/call') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      // CSRF defence-in-depth (on top of the SameSite=Lax cookie): reject a cross-site Origin.
      // Hosted deployments set ALLOWED_ORIGIN (e.g. https://hub.hirey.ai) so the check doesn't
      // depend on how the CDN rewrites the Host header; locally it falls back to the request host.
      const origin = req.headers.origin;
      if (origin) {
        let okOrigin;
        if (ALLOWED_ORIGIN) okOrigin = origin === ALLOWED_ORIGIN;
        else { try { okOrigin = new URL(origin).host === req.headers.host; } catch { okOrigin = false; } }
        if (!okOrigin) return sendJson(res, 403, { ok: false, error: 'bad_origin' });
      }
      let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
      const { capability, action } = body; const params = body.params || {};
      if (!isAllowed(capability, action)) return sendJson(res, 403, { ok: false, error: `not allowed: ${capability}.${action}` });
      if (HOSTED) {
        const ip = clientIp(req);
        const inc = parseCookies(req).hl_sid;
        const willMint = !isRead(capability, action) && !(inc && SID_RE.test(inc) && sessions.has(inc));
        if (willMint && !rateOk(ip, 'mint', 20, 60_000)) return sendJson(res, 429, { ok: false, error: 'rate_limited' });
        if (action === 'bind' && (capability === 'hi.email-binding' || capability === 'hi.phone-binding') && !rateOk(ip, 'otp', 5, 600_000))
          return sendJson(res, 429, { ok: false, error: 'too_many_codes' });
      }
      let cookie = null;
      const { ctx, sid } = await ctxFor(req, capability, action, (c) => { cookie = c; });
      const { status, json } = await ctx.call(capability, action, params);
      const identity = status === 200 ? detectLogin(capability, action, params, json?.result) : null;
      if (identity) {
        ctx.bound = true; ctx.identity = identity;
        // session-fixation defence: rotate the sid at the login (privilege elevation) boundary
        if (sid) { const rot = newSid(); sessions.delete(sid); sessions.set(rot, ctx); cookie = sessionCookie(rot); }
      }
      return sendJson(res, status, json, cookie ? { 'set-cookie': cookie } : undefined);
    }

    // static files (+ SPA fallback to index.html). Mount-path agnostic: the front-end uses
    // URLs relative to location.pathname, so this works at "/" or under "/1005/demo/".
    const rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (filePath.startsWith(PUBLIC_DIR) && existsSync(filePath) && extname(filePath)) {
      const data = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      return res.end(data);
    }
    const idx = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(idx);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

async function bootstrap() {
  console.log(`Hirey LinkedIn — starting up (${HOSTED ? 'hosted/multi-tenant' : 'local'})…`);
  serviceCtx = new AgentCtx(await loadServiceCreds());
  await activate(serviceCtx);
  await serviceCtx.getToken();
  // Self-heal: agent-scoped reads (peers_feed) need an *activated, materialized* agent. A cached
  // service agent can lapse (idle-agent cleanup). Probe once; if stale, register a fresh one.
  try {
    const probe = await serviceCtx.call('hi.owners', 'peers_feed', { limit: 1 });
    if (probe.json && probe.json.error === 'missing_caller_agent_id') {
      console.log('  ↳ cached service agent is stale — registering a fresh one');
      serviceCtx = new AgentCtx(await registerAgent('hirey-linkedin', true));
      await activate(serviceCtx);
      await serviceCtx.getToken();
    }
  } catch { /* network hiccup — keep going, /api/feed still works via search */ }
}

bootstrap()
  .then(() => server.listen(PORT, () => {
    console.log(`\n  ▸ Hirey LinkedIn is live at  http://localhost:${PORT}`);
    console.log(`  ▸ service agent              ${serviceCtx.creds.agent_id || '(env credentials)'}`);
    console.log(`  ▸ mode                       ${HOSTED ? 'hosted — per-session identity for writes' : 'local — single identity'}`);
    console.log(`  ▸ talking to                 ${HI_BASE}\n`);
  }))
  .catch((e) => { console.error('\n  ✗ bootstrap failed:', e.message, '\n'); process.exit(1); });
