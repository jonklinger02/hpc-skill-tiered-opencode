#!/usr/bin/env node
/**
 * dashboard.js — HPC live observability dashboard
 *
 * Single-file Node.js server (built-in `http` only, no npm deps) that exposes
 * a JSON API over an HPC workspace and serves a vanilla-JS dashboard at /.
 *
 * Usage:
 *   node dashboard.js --workspace <path> [--port 3000] [--host 127.0.0.1]
 *
 * Bind defaults to 127.0.0.1 (loopback only). The dashboard has no
 * authentication, so it should not be exposed beyond localhost by default.
 * To watch from another machine, pass an explicit --host (e.g. 0.0.0.0) only
 * on a network you trust. Read-only on the workspace; never writes back.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── args ──────────────────────────────────────────────────────────────────
const args = (() => {
  const a = { workspace: process.cwd(), port: 3000, host: "127.0.0.1" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace") a.workspace = path.resolve(argv[++i]);
    else if (argv[i] === "--port") a.port = parseInt(argv[++i]);
    else if (argv[i] === "--host") a.host = argv[++i];
  }
  return a;
})();

const WORKSPACE = args.workspace;
const STORE = path.join(WORKSPACE, "store", "state.json");
const MANIFEST = path.join(WORKSPACE, "manifest");
const TASKS = path.join(MANIFEST, "tasks");
const CONTRACTS = path.join(MANIFEST, "contracts");
const EPICS = path.join(MANIFEST, "epics");
const FORKS = path.join(MANIFEST, "forks");
const LOGS = path.join(WORKSPACE, "execute-logs");
const UI_HTML = path.join(__dirname, "dashboard-ui.html");

// ── helpers ───────────────────────────────────────────────────────────────
const readJSON = (f, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return fallback; }
};
const readText = (f, fallback = "") => {
  try { return fs.readFileSync(f, "utf-8"); } catch { return fallback; }
};
const safeStat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Crude YAML scalar/list extraction. The HPC manifest YAMLs are simple
// enough that we don't need a real parser for the handful of fields we read.
const yScalar = (text, key) => {
  const m = text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m"));
  return m ? m[1].trim() : null;
};
const yList = (text, key) => {
  const re = new RegExp(`^${key}:\\s*(?:\\[\\]|\\n((?:\\s+-\\s*[^\\n]+\\n?)+))`, "m");
  const m = text.match(re);
  if (!m || !m[1]) return [];
  return m[1].split("\n").map(l => l.replace(/^\s*-\s*/, "").trim().replace(/^"|"$/g, "")).filter(Boolean);
};

// ── data builders ────────────────────────────────────────────────────────
function buildState() {
  const s = readJSON(STORE, { tasks: {} });
  const counts = {};
  for (const t of Object.values(s.tasks || {})) counts[t.status] = (counts[t.status] || 0) + 1;
  return {
    counts,
    total: Object.keys(s.tasks || {}).length,
    version: s.version || 0,
    last_updated: safeStat(STORE)?.mtime || null,
    workspace: WORKSPACE,
  };
}

function listTasks() {
  const s = readJSON(STORE, { tasks: {} });
  return Object.entries(s.tasks || {}).map(([id, t]) => ({
    id,
    status: t.status,
    retry_count: t.retry_count || 0,
    requeue_count: t.requeue_count || 0,
    locked_by: t.locked_by || null,
    started_at: t.started_at || null,
    completed_at: t.completed_at || null,
    blocked_at: t.blocked_at || null,
    assigned_fork_id: t.assigned_fork_id || null,
    blocked_by_upstream: t.blocked_by_upstream || null,
    worker_model_override: t.worker_model_override || null,
    last_error: (() => {
      if (!t.error_history || !t.error_history.length) return null;
      const e = t.error_history[t.error_history.length - 1];
      return typeof e === "string" ? e.slice(0, 240) : JSON.stringify(e).slice(0, 240);
    })(),
    validation_result: t.validation_result || null,
  }));
}

function getTask(id) {
  const s = readJSON(STORE, { tasks: {} });
  const state = s.tasks?.[id];
  if (!state) return { error: "task not found" };
  // Find the spec file by id (filename usually matches task_id).
  const specFiles = listDir(TASKS).filter(f => f.endsWith(".yaml"));
  let spec = null, specFile = null;
  for (const f of specFiles) {
    const text = readText(path.join(TASKS, f));
    if (yScalar(text, "task_id") === id) { spec = text; specFile = f; break; }
  }
  return {
    id,
    state,
    spec: spec ? { file: specFile, body: spec } : null,
  };
}

function listForks() {
  const all = listDir(FORKS).filter(d => d.startsWith("FORK-"));
  const pending = [], resolved = [];
  for (const name of all) {
    const isResolved = name.endsWith(".resolved");
    const dir = path.join(FORKS, name);
    const origin = readText(path.join(dir, "origin.yaml"));
    if (!origin) continue;
    const meta = {
      fork_id: yScalar(origin, "fork_id") || name,
      originating_task_id: yScalar(origin, "originating_task_id"),
      originating_area: yScalar(origin, "originating_area"),
      council_tier: yScalar(origin, "council_tier"),
      created_at: yScalar(origin, "fork_created_at"),
      dir_name: name,
      has_human_guidance: /\nhuman_guidance:/.test(origin),
    };
    if (isResolved) {
      // Try to find an outcome marker in the dir
      const stat = safeStat(dir);
      meta.resolved_at = stat?.mtime || null;
      // Count amendments
      const tasksDir = path.join(dir, "amended", "tasks");
      const contractsDir = path.join(dir, "amended", "contracts");
      meta.amendments = {
        tasks: listDir(tasksDir).filter(f => f.endsWith(".yaml")).length,
        contracts: listDir(contractsDir).filter(f => f.endsWith(".yaml")).length,
      };
      resolved.push(meta);
    } else {
      pending.push(meta);
    }
  }
  // Sort: pending first by oldest, resolved by most-recent first.
  pending.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  resolved.sort((a, b) => (b.resolved_at?.toString() || "").localeCompare(a.resolved_at?.toString() || ""));
  return { pending, resolved };
}

function getFork(forkOrDirName) {
  // Accept either "FORK-..." or "FORK-....resolved" or just the canonical fork_id.
  const all = listDir(FORKS);
  const dirName = all.find(n => n === forkOrDirName)
    || all.find(n => n === forkOrDirName + ".resolved")
    || all.find(n => n.startsWith(forkOrDirName + "-") || n.startsWith(forkOrDirName));
  if (!dirName) return { error: "fork not found" };
  const dir = path.join(FORKS, dirName);
  const origin = readText(path.join(dir, "origin.yaml"));
  // Collect amended task and contract files.
  const amendDir = path.join(dir, "amended");
  const amTasks = listDir(path.join(amendDir, "tasks")).filter(f => f.endsWith(".yaml"))
    .map(f => ({ name: f, body: readText(path.join(amendDir, "tasks", f)) }));
  const amContracts = listDir(path.join(amendDir, "contracts")).filter(f => f.endsWith(".yaml"))
    .map(f => ({ name: f, body: readText(path.join(amendDir, "contracts", f)) }));
  // Original task body (if scoped)
  const origTasksDir = path.join(dir, "tasks");
  const origTasks = listDir(origTasksDir).filter(f => f.endsWith(".yaml"))
    .map(f => ({ name: f, body: readText(path.join(origTasksDir, f)) }));
  return {
    fork_id: yScalar(origin, "fork_id") || dirName,
    dir_name: dirName,
    resolved: dirName.endsWith(".resolved"),
    origin_yaml: origin,
    original_tasks: origTasks,
    amended_tasks: amTasks,
    amended_contracts: amContracts,
  };
}

function listManifest() {
  const summarize = (dir) => listDir(dir).filter(f => f.endsWith(".yaml")).map(f => {
    const text = readText(path.join(dir, f));
    return {
      file: f,
      id: yScalar(text, "task_id") || yScalar(text, "contract_id") || yScalar(text, "epic_id") || f.replace(".yaml", ""),
      area: yScalar(text, "originating_area") || yScalar(text, "area") || null,
      epic_id: yScalar(text, "epic_id") || null,
      file_path: yScalar(text, "file_path") || null,
      depends_on: yList(text, "depends_on"),
    };
  });
  return {
    epics: summarize(EPICS),
    tasks: summarize(TASKS),
    contracts: summarize(CONTRACTS),
  };
}

function readManifestFile(rel) {
  // rel is like "tasks/FOO.yaml" or "contracts/BAR.yaml" or "epics/EPIC-001.yaml"
  const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, "");
  const full = path.join(MANIFEST, safe);
  if (!full.startsWith(MANIFEST + path.sep)) return { error: "out of bounds" };
  return { file: rel, body: readText(full, null) };
}

function listLogs() {
  const files = listDir(LOGS).filter(f => f.endsWith(".log")).map(f => {
    const st = safeStat(path.join(LOGS, f));
    return { name: f, size: st?.size || 0, mtime: st?.mtime || null };
  }).sort((a, b) => (b.mtime?.toString() || "").localeCompare(a.mtime?.toString() || ""));
  return files;
}

function readLog(name, tailN = 100) {
  const safe = path.basename(name);
  const full = path.join(LOGS, safe);
  const text = readText(full, null);
  if (text == null) return { error: "log not found" };
  const lines = text.split("\n");
  return { name: safe, total_lines: lines.length, lines: lines.slice(-tailN) };
}

function buildDag() {
  const all = listDir(TASKS).filter(f => f.endsWith(".yaml"));
  const tasks = {};
  for (const f of all) {
    const text = readText(path.join(TASKS, f));
    const id = yScalar(text, "task_id");
    if (!id) continue;
    tasks[id] = {
      id,
      epic_id: yScalar(text, "epic_id"),
      area: yScalar(text, "originating_area") || (id.split("-")[1] || null),
      depends_on: yList(text, "depends_on"),
    };
  }
  // Compute layer = 1 + max(layer of deps); roots = 0.
  const layer = {};
  const compute = (id, stack = new Set()) => {
    if (id in layer) return layer[id];
    if (stack.has(id)) return 0; // cycle guard
    stack.add(id);
    const deps = (tasks[id]?.depends_on || []).filter(d => d in tasks);
    const l = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(d => compute(d, stack)));
    layer[id] = l;
    stack.delete(id);
    return l;
  };
  for (const id of Object.keys(tasks)) compute(id);

  // Merge in current status from store.
  const state = readJSON(STORE, { tasks: {} });
  const nodes = Object.values(tasks).map(t => ({
    id: t.id, epic_id: t.epic_id, area: t.area,
    layer: layer[t.id] ?? 0,
    status: state.tasks?.[t.id]?.status || "UNKNOWN",
  }));
  const edges = Object.values(tasks).flatMap(t =>
    (t.depends_on || []).filter(d => d in tasks).map(d => ({ from: d, to: t.id }))
  );
  return { nodes, edges };
}

// Parse execute-logs/*.log into a chronological event stream for playback.
// We extract the event class, task id, fork id, and raw message.
function buildHistory() {
  const files = listLogs();
  const events = [];
  // Match leading [ISO timestamp]
  const tsRx = /^\[([0-9TZ:.-]+)\]\s*(.*)$/;
  for (const f of files) {
    const text = readText(path.join(LOGS, f.name));
    for (const line of text.split("\n")) {
      const m = line.match(tsRx);
      if (!m) continue;
      const [, ts, body] = m;
      const tMatch = body.match(/task=([\w./-]+)/);
      const fMatch = body.match(/fork=([\w./-]+)/);
      let kind = "log";
      if (body.startsWith("worker-start")) kind = "worker_start";
      else if (body.startsWith("worker-err")) kind = "worker_err";
      else if (body.startsWith("worker-promoted")) kind = "worker_promoted";
      else if (body.startsWith("task-ok")) kind = "task_ok";
      else if (body.startsWith("validator-err")) kind = "validator_err";
      else if (body.startsWith("ui-validator-err")) kind = "ui_validator_err";
      else if (body.startsWith("normalize")) kind = "normalize";
      else if (body.startsWith("escalation-decision")) kind = "escalation";
      else if (body.startsWith("rescue-escalated")) kind = "rescue";
      else if (body.startsWith("BLOCKED") || body.startsWith("blocked")) kind = "block";
      events.push({
        ts, kind,
        task_id: tMatch?.[1] || null,
        fork_id: fMatch?.[1] || null,
        body: body.slice(0, 320),
        log_file: f.name,
      });
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}

// ── routing ──────────────────────────────────────────────────────────────
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;
  // Make u.query feel like the legacy url.parse(...).query
  u.query = Object.fromEntries(u.searchParams.entries());
  try {
    if (req.method === "GET" && p === "/") {
      const html = readText(UI_HTML, "<h1>dashboard-ui.html missing</h1>");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "GET" && p === "/api/state") return send(res, 200, buildState());
    if (req.method === "GET" && p === "/api/tasks") return send(res, 200, listTasks());
    if (req.method === "GET" && p.startsWith("/api/tasks/")) return send(res, 200, getTask(decodeURIComponent(p.slice("/api/tasks/".length))));
    if (req.method === "GET" && p === "/api/forks") return send(res, 200, listForks());
    if (req.method === "GET" && p.startsWith("/api/forks/")) return send(res, 200, getFork(decodeURIComponent(p.slice("/api/forks/".length))));
    if (req.method === "GET" && p === "/api/manifest") return send(res, 200, listManifest());
    if (req.method === "GET" && p === "/api/manifest/file") return send(res, 200, readManifestFile(u.query.path || ""));
    if (req.method === "GET" && p === "/api/logs") return send(res, 200, listLogs());
    if (req.method === "GET" && p === "/api/log") {
      const name = u.query.name;
      const tail = parseInt(u.query.tail) || 100;
      if (!name) {
        // Default: latest log
        const files = listLogs();
        if (!files.length) return send(res, 200, { error: "no logs" });
        return send(res, 200, readLog(files[0].name, tail));
      }
      return send(res, 200, readLog(name, tail));
    }
    if (req.method === "GET" && p === "/api/dag") return send(res, 200, buildDag());
    if (req.method === "GET" && p === "/api/history") return send(res, 200, buildHistory());
    return send(res, 404, { error: "not found", path: p });
  } catch (e) {
    return send(res, 500, { error: e.message, stack: e.stack?.split("\n").slice(0, 5) });
  }
});

server.listen(args.port, args.host, () => {
  console.log(`HPC dashboard — workspace: ${WORKSPACE}`);
  console.log(`Listening on http://${args.host}:${args.port}/`);
  // When the operator has explicitly bound to a wildcard address, surface the
  // concrete reachable URLs per non-loopback IPv4 interface. Skipped for the
  // default loopback bind, where only localhost is reachable.
  const wildcard = args.host === "0.0.0.0" || args.host === "::";
  if (wildcard) {
    const reachable = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === "IPv4" && !a.internal) reachable.push({ iface: name, addr: a.address });
      }
    }
    if (reachable.length) {
      console.log(`Reachable at:`);
      console.log(`  http://localhost:${args.port}/`);
      for (const r of reachable) console.log(`  http://${r.addr}:${args.port}/   (${r.iface})`);
    }
  }
});
