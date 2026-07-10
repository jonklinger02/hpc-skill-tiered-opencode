"use strict";
/**
 * opencode-client.js — raw HTTP transport for the OpenCode serve API.
 *
 * Replaces all spawn("claude", ...) call sites. Every callAgent() call
 * creates its own session (no sharing across concurrent calls) and returns
 * { text } on success or { error } on any failure — never throws.
 *
 * Required env var: OPENCODE_SERVE_URL  e.g. "http://127.0.0.1:4096"
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const _SERVE_URL = process.env.OPENCODE_SERVE_URL || null;

/** Returns the configured serve URL; throws a clear error if unset. */
function getServeUrl() {
  if (!_SERVE_URL) {
    throw new Error(
      "OPENCODE_SERVE_URL is not set. Start opencode with `opencode serve` and " +
      "export OPENCODE_SERVE_URL=http://127.0.0.1:<port> before running."
    );
  }
  return _SERVE_URL;
}

/**
 * Low-level HTTP helper. Returns { status, body } — never throws.
 * Rejects on network error or timeout (caller must catch).
 */
function request(base, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const bodyStr = body != null ? JSON.stringify(body) : null;

    const headers = { Accept: "application/json" };
    if (bodyStr !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : (isHttps ? 443 : 80),
      path: url.pathname + (url.search || ""),
      method,
      headers,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") })
      );
      res.on("error", reject);
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));

    if (timeoutMs) req.setTimeout(timeoutMs);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

/**
 * Call the OpenCode serve API with a single user message.
 *
 * @param {object} opts
 * @param {string}  opts.role         — agent role label (not sent to API; for logging)
 * @param {{ providerID: string, modelID: string }} opts.model
 * @param {string}  opts.systemPrompt — omitted from request if empty
 * @param {string}  opts.userMessage
 * @param {number}  [opts.timeoutMs=1500000]
 * @param {object|null} [opts.tools]  — included only if non-null and non-empty
 * @param {string|null} [opts.effort] — reserved for future use; not sent to API
 * @returns {Promise<{ text: string } | { error: string }>}
 */
async function callAgent({
  role,          // eslint-disable-line no-unused-vars
  model,
  systemPrompt,
  userMessage,
  timeoutMs = 1500000,
  tools = null,
  effort = null, // eslint-disable-line no-unused-vars
}) {
  try {
    const base = getServeUrl();

    // ── 1. Create a fresh session ────────────────────────────────────────────
    const sessionRes = await request(base, "POST", "/session", null, timeoutMs);
    if (sessionRes.status !== 200) {
      return { error: `http ${sessionRes.status}: ${sessionRes.body.slice(0, 200)}` };
    }

    let sessionData;
    try {
      sessionData = JSON.parse(sessionRes.body);
    } catch {
      return { error: `invalid session response: ${sessionRes.body.slice(0, 200)}` };
    }

    const sessionId = sessionData.id;
    if (!sessionId) return { error: "session response missing id field" };

    // ── 2. Build and send the message ────────────────────────────────────────
    const msgBody = {
      providerID: model.providerID,
      modelID: model.modelID,
      parts: [{ type: "text", text: userMessage }],
    };
    if (systemPrompt) msgBody.system = systemPrompt;
    if (tools != null && typeof tools === "object" && Object.keys(tools).length > 0) {
      msgBody.tools = tools;
    }

    const msgRes = await request(base, "POST", `/session/${sessionId}/message`, msgBody, timeoutMs);
    if (msgRes.status !== 200) {
      return { error: `http ${msgRes.status}: ${msgRes.body.slice(0, 200)}` };
    }

    // ── 3. Extract text from response parts ──────────────────────────────────
    let msgData;
    try {
      msgData = JSON.parse(msgRes.body);
    } catch {
      return { error: `invalid message response: ${msgRes.body.slice(0, 200)}` };
    }

    const text = (msgData.parts || [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    return { text };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg === "timeout") return { error: "timeout" };
    return { error: msg };
  }
}

module.exports = { callAgent, getServeUrl };
