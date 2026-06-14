#!/usr/bin/env node
// Hirey LinkedIn — zero-dependency static server + authenticated proxy to the Hi REST API.
//
// What it does:
//   1. On first run it registers its own anonymous Hi agent (POST /v1/agents/register),
//      activates it, and caches the credentials under ~/.config/hirey-linkedin/.
//      No Hi account, no browser OAuth, no key to paste.
//   2. It serves the static LinkedIn-style front-end in ./public.
//   3. It exposes a thin, allow-listed proxy at POST /api/call that injects the
//      bearer token so the browser never sees a secret, plus a composed /api/feed.
//
// Override the identity by exporting HI_CLIENT_ID / HI_CLIENT_SECRET (e.g. to act as
// your real Hi agent). Everything else is configuration via PORT / HI_BASE_URL.

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const HI_BASE = (process.env.HI_BASE_URL || 'https://hi.hirey.ai').replace(/\/+$/, '');
const PORT = Number(process.env.PORT || 4173);
const CREDS_DIR = join(homedir(), '.config', 'hirey-linkedin');
const CREDS_PATH = join(CREDS_DIR, 'credentials.json');

// The only capabilities + actions the browser is permitted to invoke through the proxy.
// Reads are open; writes are limited to the handful a social client legitimately needs.
const ALLOW = {
  'hi.owners': new Set(['get', 'search', 'peers_feed', 'list_listings', 'list_agents', 'update_profile']),
  'hi.agent-listings': new Set(['browse_recent', 'list', 'get', 'upsert']),
  'hi.matching-sessions': new Set(['match_feed']),
  'hi.workspace-overview': new Set(['get']),
  'hi.public-pages': new Set(['get']),
  'hi.pairings': new Set(['list', 'timeline', 'create', 'contact_owner', 'contact_target']),
};

let creds = null;                 // { client_id, client_secret, agent_id, installation_id }
let token = { value: null, exp: 0 };

// ----------------------------------------------------------------------------- identity

async function registerAgent() {
  const res = await fetch(`${HI_BASE}/v1/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      display_name: 'Hirey LinkedIn',
      agent_kind: 'external',
      metadata: { host: 'hirey-linkedin' },
    }),
  });
  if (!res.ok) throw new Error(`agent register failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const c = {
    client_id: j.auth.client_id,
    client_secret: j.auth.client_secret,
    agent_id: j.agent.agent_id,
    installation_id: j.installation.installation_id,
  };
  await mkdir(CREDS_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDS_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  console.log(`  ↳ registered a fresh anonymous Hi agent: ${c.agent_id}`);
  return c;
}

async function loadCreds() {
  if (process.env.HI_CLIENT_ID && process.env.HI_CLIENT_SECRET) {
    console.log('  ↳ using HI_CLIENT_ID / HI_CLIENT_SECRET from the environment');
    return {
      client_id: process.env.HI_CLIENT_ID,
      client_secret: process.env.HI_CLIENT_SECRET,
      agent_id: process.env.HI_AGENT_ID || null,
      installation_id: null,
    };
  }
  if (existsSync(CREDS_PATH)) {
    try {
      const c = JSON.parse(await readFile(CREDS_PATH, 'utf8'));
      if (c.client_id && c.client_secret) {
        console.log(`  ↳ reusing cached agent ${c.agent_id} (${CREDS_PATH})`);
        return c;
      }
    } catch { /* fall through to re-register */ }
  }
  return registerAgent();
}

async function getToken() {
  const now = Date.now();
  if (token.value && token.exp - now > 60_000) return token.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    audience: 'hirey-hi',
  });
  const res = await fetch(`${HI_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  token = { value: j.access_token, exp: now + (j.expires_in || 3600) * 1000 };
  return token.value;
}

// ----------------------------------------------------------------------------- Hi calls

async function callHi(capability, action, params = {}) {
  const tok = await getToken();
  const res = await fetch(`${HI_BASE}/v1/capabilities/${capability}/call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: 'bad_upstream_json', raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

const FEED_SEEDS = [
  'founder', 'engineer', 'designer', 'investor', 'hiring', 'startup',
  'remote', 'product manager', 'AI', 'marketing', 'data', 'growth',
];

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Compose a LinkedIn-style home feed of authored "posts" by fanning a few fuzzy searches
// across the network and merging their listing results (which carry an owner/author).
async function buildFeed(limit = 20) {
  const seeds = shuffle(FEED_SEEDS).slice(0, 5);
  const seen = new Map();
  const batches = await Promise.all(
    seeds.map((q) => callHi('hi.owners', 'search', { q, limit: 8 }).catch(() => null)),
  );
  for (const b of batches) {
    const listings = b?.json?.result?.listings || [];
    for (const l of listings) {
      if (!l.listing_id || seen.has(l.listing_id)) continue;
      seen.set(l.listing_id, l);
    }
  }
  return [...seen.values()]
    .sort((a, b) => new Date(b.listing_created_at || 0) - new Date(a.listing_created_at || 0))
    .slice(0, limit);
}

// ----------------------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/api/health') {
      return sendJson(res, 200, { ok: true, agent_id: creds?.agent_id || null, hi_base: HI_BASE });
    }

    if (p === '/api/feed') {
      const limit = Math.min(Number(url.searchParams.get('limit') || 20) || 20, 40);
      const posts = await buildFeed(limit);
      return sendJson(res, 200, { ok: true, posts });
    }

    if (p === '/api/call') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'bad_json' }); }
      const { capability, action } = body;
      const params = body.params || {};
      if (!ALLOW[capability] || !ALLOW[capability].has(action)) {
        return sendJson(res, 403, { ok: false, error: `not allowed: ${capability}.${action}` });
      }
      const { status, json } = await callHi(capability, action, params);
      return sendJson(res, status, json);
    }

    // static files (+ SPA fallback to index.html)
    const rel = p === '/' ? '/index.html' : decodeURIComponent(p);
    const filePath = normalize(join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    if (existsSync(filePath) && extname(filePath)) {
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
  console.log('Hirey LinkedIn — starting up…');
  creds = await loadCreds();
  await getToken();
  // move the installation pending -> active (idempotent; safe to call every boot)
  try {
    await fetch(`${HI_BASE}/v1/agents/activate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
      body: '{}',
    });
  } catch { /* non-fatal */ }
}

bootstrap()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n  ▸ Hirey LinkedIn is live at  http://localhost:${PORT}`);
      console.log(`  ▸ acting as Hi agent         ${creds.agent_id}`);
      console.log(`  ▸ talking to                 ${HI_BASE}\n`);
    });
  })
  .catch((e) => {
    console.error('\n  ✗ bootstrap failed:', e.message);
    console.error('    Is the machine online and is', HI_BASE, 'reachable?\n');
    process.exit(1);
  });
