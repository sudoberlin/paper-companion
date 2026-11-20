// Paper Companion backend: a Cloudflare Worker that
//  1. checks a passcode on every request,
//  2. forwards Claude requests to the Anthropic API with the key kept server side,
//  3. fetches paper links (arXiv, OpenReview, PDFs, web pages) so the browser avoids CORS,
//  4. stores the paper library in Workers KV so it follows you across computers.

const MAX_BODY_BYTES = 4 * 1024 * 1024;      // Claude request size cap
const MAX_PAPER_BYTES = 20 * 1024 * 1024;    // one saved paper
const MAX_FETCH_BYTES = 40 * 1024 * 1024;    // one fetched PDF or page
const MAX_TOKENS_CAP = 4096;
const ID_RE = /^[a-z0-9]{4,40}$/;

const enc = new TextEncoder();

function safeEqual(a, b) {
  const x = enc.encode(String(a || ""));
  const y = enc.encode(String(b || ""));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function corsHeaders(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || !(allowed.includes(origin) || local)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, X-Passcode",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Expose-Headers": "X-Final-URL, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readJson(req, limit) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > limit) throw new HttpError(413, "Request too large.");
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, "Request too large.");
  try { return JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON."); }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/* ---------- Claude ---------- */
function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 80) return false;
  return messages.every(m => m && (m.role === "user" || m.role === "assistant") &&
    (typeof m.content === "string" || Array.isArray(m.content)));
}

async function handleClaude(req, env, cors) {
  const body = await readJson(req, MAX_BODY_BYTES);
  if (!validMessages(body.messages)) throw new HttpError(400, "messages must be a non-empty array of user/assistant turns.");
  if (body.messages[body.messages.length - 1].role !== "user") throw new HttpError(400, "The last message must be from the user.");
  const payload = {
    model: env.MODEL || "claude-sonnet-5-5",
    max_tokens: Math.min(Math.max(Number(body.max_tokens) || 1500, 64), MAX_TOKENS_CAP),
    messages: body.messages,
    stream: body.stream === true,
  };
  if (typeof body.system === "string" && body.system) payload.system = body.system;

  const base = String(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const upstream = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/* ---------- link fetching ---------- */
function blockedHost(host) {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[");
}

async function handleFetch(req, env, cors) {
  const body = await readJson(req, 8192);
  let url;
  try { url = new URL(String(body.url || "")); } catch { throw new HttpError(400, "That isn't a valid link."); }
  if (!/^https?:$/.test(url.protocol) || blockedHost(url.hostname)) throw new HttpError(400, "Only public http(s) links can be fetched.");

  const upstream = await fetch(url.toString(), {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PaperCompanion/1.0; +https://sudoberlin.github.io)",
      Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
    },
  });
  if (!upstream.ok) return json({ error: `The site answered with HTTP ${upstream.status}.`, status: upstream.status }, 502, cors);
  const len = Number(upstream.headers.get("Content-Length") || 0);
  if (len > MAX_FETCH_BYTES) return json({ error: "That file is too large to fetch (over 40 MB)." }, 413, cors);
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": upstream.headers.get("Content-Type") || "application/octet-stream",
      "X-Final-URL": upstream.url,
      "Cache-Control": "no-store",
    },
  });
}

/* ---------- library (KV) ---------- */
async function getIndex(env) {
  return (await env.LIBRARY.get("index", "json")) || [];
}

async function handleLibrary(req, env, cors, id) {
  if (!env.LIBRARY) return json({ error: "sync_disabled" }, 501, cors);
  if (!id) {
    if (req.method !== "GET") throw new HttpError(405, "Method not allowed.");
    return json(await getIndex(env), 200, cors);
  }
  if (!ID_RE.test(id)) throw new HttpError(400, "Bad paper id.");
  const key = "paper:" + id;

  if (req.method === "GET") {
    const v = await env.LIBRARY.get(key);
    if (v === null) return json({ error: "not_found" }, 404, cors);
    return new Response(v, { headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  if (req.method === "PUT") {
    const len = Number(req.headers.get("Content-Length") || 0);
    if (len > MAX_PAPER_BYTES) throw new HttpError(413, "This paper is too large to save.");
    const text = await req.text();
    if (text.length > MAX_PAPER_BYTES) throw new HttpError(413, "This paper is too large to save.");
    let paper;
    try { paper = JSON.parse(text); } catch { throw new HttpError(400, "Body must be JSON."); }
    await env.LIBRARY.put(key, text);
    // Only rewrite the index when something it shows changed: KV's free tier allows 1,000 writes a day.
    const title = String((paper.overview && paper.overview.title) || paper.name || "Untitled").slice(0, 300);
    const index = await getIndex(env);
    const i = index.findIndex(x => x.id === id);
    if (i < 0) { index.unshift({ id, title, added: Number(paper.added) || Date.now() }); await env.LIBRARY.put("index", JSON.stringify(index)); }
    else if (index[i].title !== title) { index[i].title = title; await env.LIBRARY.put("index", JSON.stringify(index)); }
    return json({ ok: true }, 200, cors);
  }
  if (req.method === "DELETE") {
    await env.LIBRARY.delete(key);
    const index = (await getIndex(env)).filter(x => x.id !== id);
    await env.LIBRARY.put("index", JSON.stringify(index));
    return json({ ok: true }, 200, cors);
  }
  throw new HttpError(405, "Method not allowed.");
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!url.pathname.startsWith("/api/")) return json({ ok: true, service: "paper-companion" }, 200, cors);

    if (!env.PASSCODE || !env.ANTHROPIC_API_KEY) {
      return json({ error: "The Worker is missing its PASSCODE or ANTHROPIC_API_KEY secret. See the README." }, 500, cors);
    }
    if (!safeEqual(req.headers.get("X-Passcode"), env.PASSCODE)) {
      await new Promise(r => setTimeout(r, 500)); // slow down guessing
      return json({ error: "bad_passcode" }, 401, cors);
    }

    try {
      const path = url.pathname;
      if (path === "/api/health" && req.method === "GET") return json({ ok: true, model: env.MODEL || "claude-sonnet-5-5", sync: !!env.LIBRARY }, 200, cors);
      if (path === "/api/claude" && req.method === "POST") return await handleClaude(req, env, cors);
      if (path === "/api/fetch" && req.method === "POST") return await handleFetch(req, env, cors);
      const m = path.match(/^\/api\/papers(?:\/([^/]+))?$/);
      if (m) return await handleLibrary(req, env, cors, m[1]);
      return json({ error: "Not found." }, 404, cors);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      return json({ error: e instanceof HttpError ? e.message : "The Worker hit an error: " + (e && e.message) }, status, cors);
    }
  },
};
