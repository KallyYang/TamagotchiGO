/**
 * TamagotchiGO Cloudflare Worker
 *
 * 该 Worker 同时承担两件事：
 * 1. 通过 `assets` 绑定（在 wrangler.toml 中声明）托管 `web/` 静态目录；
 * 2. 处理 `/api/save*` 路由，将 EEPROM 存档存放在 Workers KV（绑定名 SAVE_KV）。
 *
 * 鉴权：可选的 SAVE_TOKEN 环境变量。
 *   - 未配置：所有 API 公开（适合单人使用，部署在自己专属域名下）。
 *   - 已配置：读写都需要在 `X-Save-Token` 请求头或 `?token=` query 中提供同样的值。
 */

const SLOT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_SLOT = "default";
const USERNAME_PATTERN = /^[A-Za-z0-9_\-\.]{2,32}$/;
const AUTH_USER_PREFIX = "user:";
const AUTH_DEFAULT_ITERATIONS = 200000;

function jsonResponse(data, init) {
  init = init || {};
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: headers,
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  // 这里默认仅允许同源请求，所以无 Origin 时直接放行（同源不会带 Origin）。
  // 如果存在 Origin，就回显它，方便潜在的跨域调试调用，但不附带 Cookie。
  const headers = new Headers();
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
    headers.set(
      "access-control-allow-headers",
      "content-type, x-save-token"
    );
    headers.set("access-control-allow-methods", "GET, PUT, DELETE, OPTIONS");
  }
  return headers;
}

function withCors(response, request) {
  const cors = corsHeaders(request);
  cors.forEach((value, key) => response.headers.set(key, value));
  return response;
}

function getSlot(url) {
  const slot = url.searchParams.get("slot") || DEFAULT_SLOT;
  if (!SLOT_PATTERN.test(slot)) {
    return null;
  }
  return slot;
}

function tokenOk(request, url, env) {
  const expected = env.SAVE_TOKEN;
  if (!expected) {
    return true;
  }
  const provided =
    request.headers.get("x-save-token") || url.searchParams.get("token");
  return provided === expected;
}

function kvKey(slot) {
  return `save:${slot}`;
}

async function handleHealth(request, env) {
  return withCors(
    jsonResponse({
      ok: true,
      hasToken: Boolean(env.SAVE_TOKEN),
      kvBound: Boolean(env.SAVE_KV),
    }),
    request
  );
}

async function handleGetSave(request, url, env) {
  if (!env.SAVE_KV) {
    return withCors(
      jsonResponse({ error: "kv_not_bound" }, { status: 500 }),
      request
    );
  }
  if (!tokenOk(request, url, env)) {
    return withCors(
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
      request
    );
  }
  const slot = getSlot(url);
  if (!slot) {
    return withCors(
      jsonResponse({ error: "invalid_slot" }, { status: 400 }),
      request
    );
  }

  const raw = await env.SAVE_KV.get(kvKey(slot));
  if (!raw) {
    return withCors(
      jsonResponse({ error: "not_found", slot }, { status: 404 }),
      request
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return withCors(
      jsonResponse({ error: "corrupt_payload" }, { status: 500 }),
      request
    );
  }

  return withCors(jsonResponse({ slot, payload: parsed }), request);
}

async function handlePutSave(request, url, env) {
  if (!env.SAVE_KV) {
    return withCors(
      jsonResponse({ error: "kv_not_bound" }, { status: 500 }),
      request
    );
  }
  if (!tokenOk(request, url, env)) {
    return withCors(
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
      request
    );
  }
  const slot = getSlot(url);
  if (!slot) {
    return withCors(
      jsonResponse({ error: "invalid_slot" }, { status: 400 }),
      request
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return withCors(
      jsonResponse({ error: "invalid_json" }, { status: 400 }),
      request
    );
  }

  if (
    !body ||
    body.format !== "tamago-eeprom-v1" ||
    typeof body.data !== "string" ||
    body.data.length === 0 ||
    body.data.length % 2 !== 0 ||
    !/^[0-9a-fA-F]+$/.test(body.data)
  ) {
    return withCors(
      jsonResponse({ error: "invalid_payload" }, { status: 400 }),
      request
    );
  }

  // 存储体上限（避免被填满）：64 KiB hex 已足够（对应 32 KiB EEPROM）。
  if (body.data.length > 64 * 1024) {
    return withCors(
      jsonResponse({ error: "payload_too_large" }, { status: 413 }),
      request
    );
  }

  const stored = {
    format: "tamago-eeprom-v1",
    bytes: body.data.length / 2,
    data: body.data,
    updatedAt: new Date().toISOString(),
  };

  await env.SAVE_KV.put(kvKey(slot), JSON.stringify(stored));

  return withCors(
    jsonResponse({ ok: true, slot, updatedAt: stored.updatedAt }),
    request
  );
}

async function handleDeleteSave(request, url, env) {
  if (!env.SAVE_KV) {
    return withCors(
      jsonResponse({ error: "kv_not_bound" }, { status: 500 }),
      request
    );
  }
  if (!tokenOk(request, url, env)) {
    return withCors(
      jsonResponse({ error: "unauthorized" }, { status: 401 }),
      request
    );
  }
  const slot = getSlot(url);
  if (!slot) {
    return withCors(
      jsonResponse({ error: "invalid_slot" }, { status: 400 }),
      request
    );
  }

  await env.SAVE_KV.delete(kvKey(slot));
  return withCors(jsonResponse({ ok: true, slot }), request);
}

function authKv(env) {
  return env.AUTH_KV || env.SAVE_KV || null;
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(buffer) {
  const view = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += (0x100 | view[i]).toString(16).slice(1);
  }
  return out;
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function pbkdf2Sha256Hex(password, saltHex, iterations, keyLengthBytes) {
  const saltBytes = hexToBytes(saltHex);
  if (!saltBytes) {
    return null;
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: iterations,
      hash: "SHA-256",
    },
    key,
    keyLengthBytes * 8
  );
  return bytesToHex(bits);
}

async function handleAuthHealth(request, env) {
  return withCors(
    jsonResponse({
      ok: true,
      kvBound: Boolean(authKv(env)),
    }),
    request
  );
}

async function handleAuthLogin(request, env) {
  const kv = authKv(env);
  if (!kv) {
    return withCors(
      jsonResponse({ ok: false, error: "kv_not_bound" }, { status: 500 }),
      request
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return withCors(
      jsonResponse({ ok: false, error: "invalid_json" }, { status: 400 }),
      request
    );
  }

  const username = (body && typeof body.username === "string" ? body.username : "").trim();
  const password = body && typeof body.password === "string" ? body.password : "";

  if (!USERNAME_PATTERN.test(username)) {
    return withCors(
      jsonResponse({ ok: false, error: "invalid_credentials" }, { status: 401 }),
      request
    );
  }
  if (!password || password.length > 128) {
    return withCors(
      jsonResponse({ ok: false, error: "invalid_credentials" }, { status: 401 }),
      request
    );
  }

  const raw = await kv.get(AUTH_USER_PREFIX + username);
  if (!raw) {
    return withCors(
      jsonResponse({ ok: false, error: "invalid_credentials" }, { status: 401 }),
      request
    );
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return withCors(
      jsonResponse({ ok: false, error: "corrupt_record" }, { status: 500 }),
      request
    );
  }

  const algo = (record.algo || "pbkdf2-sha256").toLowerCase();
  if (algo !== "pbkdf2-sha256") {
    return withCors(
      jsonResponse({ ok: false, error: "unsupported_algo" }, { status: 500 }),
      request
    );
  }

  const iterations = Number(record.iterations) || AUTH_DEFAULT_ITERATIONS;
  const expectedHex = String(record.hash || "");
  const keyLength = expectedHex.length / 2 || 32;

  let actualHex;
  try {
    actualHex = await pbkdf2Sha256Hex(password, record.salt || "", iterations, keyLength);
  } catch (e) {
    return withCors(
      jsonResponse({ ok: false, error: "hash_failed" }, { status: 500 }),
      request
    );
  }

  if (!actualHex || !constantTimeEqualHex(actualHex, expectedHex)) {
    return withCors(
      jsonResponse({ ok: false, error: "invalid_credentials" }, { status: 401 }),
      request
    );
  }

  return withCors(
    jsonResponse({
      ok: true,
      account: {
        username: username,
      },
    }),
    request
  );
}

async function handleApi(request, url, env) {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), request);
  }

  if (url.pathname === "/api/save/health" && request.method === "GET") {
    return handleHealth(request, env);
  }

  if (url.pathname === "/api/auth/health" && request.method === "GET") {
    return handleAuthHealth(request, env);
  }

  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    return handleAuthLogin(request, env);
  }

  if (url.pathname === "/api/save") {
    if (request.method === "GET") return handleGetSave(request, url, env);
    if (request.method === "PUT") return handlePutSave(request, url, env);
    if (request.method === "DELETE") return handleDeleteSave(request, url, env);
    return withCors(
      jsonResponse({ error: "method_not_allowed" }, { status: 405 }),
      request
    );
  }

  return withCors(
    jsonResponse({ error: "not_found" }, { status: 404 }),
    request
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env);
    }

    // 其它路径全部委派给 Static Assets。
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
