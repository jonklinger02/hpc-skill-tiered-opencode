#!/usr/bin/env node
// Tests for task-store.js — state machine operations: init, status, lock,
// complete, block, batch query, and promote-worker.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node task-store.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE_SCRIPT = path.resolve(__dirname, "task-store.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-store-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run task-store.js with the given subcommand and options.
 * Returns trimmed stdout; never throws.
 */
function run(subcommand, opts = {}) {
  const parts = [`node "${STORE_SCRIPT}" ${subcommand}`];
  if (opts.store)       parts.push(`--store "${opts.store}"`);
  if (opts.manifestDir) parts.push(`--manifest-dir "${opts.manifestDir}"`);
  if (opts.taskId)      parts.push(`--task-id "${opts.taskId}"`);
  if (opts.worker)      parts.push(`--worker "${opts.worker}"`);
  if (opts.reason)      parts.push(`--reason "${opts.reason}"`);
  if (opts.upstream)    parts.push(`--upstream "${opts.upstream}"`);
  if (opts.forkId)      parts.push(`--fork-id "${opts.forkId}"`);
  if (opts.model)       parts.push(`--model "${opts.model}"`);
  try {
    return execSync(parts.join(" "), { encoding: "utf-8" }).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/** Read and parse the JSON state file. */
function readState(storePath) {
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

/** Fixture: three task YAMLs for a simple chain A → B → C */
const TASKS = {
  "tasks/TASK-001.yaml": "task_id: TASK-001\ndepends_on: []",
  "tasks/TASK-002.yaml": "task_id: TASK-002\ndepends_on:\n  - TASK-001",
  "tasks/TASK-003.yaml": "task_id: TASK-003\ndepends_on:\n  - TASK-002",
};

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

test("task-store init: creates state file with all tasks in PLANNED", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  try {
    const result = run("init", { store: storePath, manifestDir: dir });
    assert.match(result, /^ok:/, "should return ok:<count> tasks loaded");

    const state = readState(storePath);
    assert.equal(state._version, 1, "state version should be 1");
    assert.ok(state.tasks["TASK-001"], "TASK-001 should be in store");
    assert.ok(state.tasks["TASK-002"], "TASK-002 should be in store");
    assert.ok(state.tasks["TASK-003"], "TASK-003 should be in store");
    assert.equal(state.tasks["TASK-001"].status, "PLANNED");
    assert.equal(state.tasks["TASK-002"].status, "PLANNED");
    assert.equal(state.tasks["TASK-003"].status, "PLANNED");
  } finally { rm(dir); }
});

test("task-store init: count in response matches number of tasks", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  try {
    const result = run("init", { store: storePath, manifestDir: dir });
    // Result is "ok:3 tasks loaded"
    assert.match(result, /ok:3/, "should report loading 3 tasks");
  } finally { rm(dir); }
});

test("task-store init: empty tasks dir → err", () => {
  const dir = makeTempDir();
  const storePath = path.join(dir, "store", "state.json");
  try {
    const result = run("init", { store: storePath, manifestDir: dir });
    assert.match(result, /err:/, "should fail when no tasks found");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════════════════

test("task-store status: reports correct counts after init", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("status", { store: storePath });
    // Actual format: [PLANNED:3] [COMPLETE:0] ... total:3
    assert.match(result, /\[PLANNED:3\]/, "all 3 tasks should be PLANNED");
    assert.match(result, /total:3/, "total should be 3");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// LOCK
// ═══════════════════════════════════════════════════════════════════════════

test("task-store lock: transitions PLANNED → LOCKED", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("lock", { store: storePath, taskId: "TASK-001", worker: "worker-abc" });
    assert.match(result, /^ok/, "lock should succeed");

    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].status, "LOCKED");
    assert.equal(state.tasks["TASK-001"].locked_by, "worker-abc");
    assert.ok(state.tasks["TASK-001"].locked_at, "locked_at should be set");
  } finally { rm(dir); }
});

test("task-store lock: double-lock is refused — err:cannot_lock and state stays LOCKED with original worker", () => {
  // lock() refuses any task not in PLANNED and reports the refusal on stdout
  // so callers (execute.js) can skip dispatching a duplicate worker.
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  run("lock", { store: storePath, taskId: "TASK-001", worker: "worker-1" });
  try {
    const result = run("lock", { store: storePath, taskId: "TASK-001", worker: "worker-2" });
    assert.match(result, /^err:cannot_lock:current_status=LOCKED/, "refusal must be reported, not ok");
    // The original lock should be preserved
    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].locked_by, "worker-1", "original lock should be unchanged");
  } finally { rm(dir); }
});

test("task-store lock: unknown task → err:task_not_found", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("lock", { store: storePath, taskId: "TASK-999", worker: "worker-1" });
    assert.match(result, /^err:task_not_found/, "missing task must not report ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETE
// ═══════════════════════════════════════════════════════════════════════════

test("task-store complete: transitions LOCKED → COMPLETE", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  run("lock", { store: storePath, taskId: "TASK-001", worker: "worker-abc" });
  try {
    const result = run("complete", { store: storePath, taskId: "TASK-001" });
    assert.match(result, /^ok/, "complete should succeed");

    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].status, "COMPLETE");
    assert.ok(state.tasks["TASK-001"].completed_at, "completed_at should be set");
  } finally { rm(dir); }
});

test("task-store complete: lenient — completes even a PLANNED task (no lock-check)", () => {
  // complete() does not verify the task is LOCKED first — it transitions directly
  // to COMPLETE regardless of prior state. This is intentional in task-store.js.
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("complete", { store: storePath, taskId: "TASK-001" });
    assert.match(result, /^ok/, "complete returns ok");
    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].status, "COMPLETE", "task is COMPLETE despite never being LOCKED");
  } finally { rm(dir); }
});

test("task-store complete: unknown task → err:task_not_found", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("complete", { store: storePath, taskId: "TASK-999" });
    assert.match(result, /^err:task_not_found/, "missing task must not report ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// BLOCK
// ═══════════════════════════════════════════════════════════════════════════

test("task-store block: transitions task to BLOCKED", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("block", { store: storePath, taskId: "TASK-001", forkId: "FORK-001" });
    assert.match(result, /^ok/, "block should succeed");

    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].status, "BLOCKED");
    assert.equal(state.tasks["TASK-001"].assigned_fork_id, "FORK-001");
    assert.ok(state.tasks["TASK-001"].blocked_at, "blocked_at should be set");
  } finally { rm(dir); }
});

test("task-store block: upstream recorded when provided", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    run("block", {
      store: storePath,
      taskId: "TASK-002",
      upstream: "TASK-001",
      forkId: "FORK-002",
    });
    const state = readState(storePath);
    assert.equal(state.tasks["TASK-002"].blocked_by_upstream, "TASK-001");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// STATUS COUNTS AFTER MIXED OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

test("task-store status: reflects mixed state correctly", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  // Complete TASK-001
  run("lock",     { store: storePath, taskId: "TASK-001", worker: "w1" });
  run("complete", { store: storePath, taskId: "TASK-001" });
  // Block TASK-002
  run("block",    { store: storePath, taskId: "TASK-002", forkId: "FORK-X" });
  try {
    const result = run("status", { store: storePath });
    assert.match(result, /\[COMPLETE:1\]/, "1 task complete");
    assert.match(result, /\[BLOCKED:1\]/,  "1 task blocked");
    assert.match(result, /\[PLANNED:1\]/,  "1 task still planned");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// RESET-STALE (sanity check — doesn't mutate COMPLETE tasks)
// ═══════════════════════════════════════════════════════════════════════════

test("task-store reset-stale: COMPLETE tasks are not touched", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  run("lock",     { store: storePath, taskId: "TASK-001", worker: "w1" });
  run("complete", { store: storePath, taskId: "TASK-001" });
  try {
    run("reset-stale", { store: storePath, timeout: 0 }); // timeout=0 forces all LOCKED back to PLANNED
    const state = readState(storePath);
    assert.equal(state.tasks["TASK-001"].status, "COMPLETE", "COMPLETE should never be reset");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PROMOTE-WORKER
// ═══════════════════════════════════════════════════════════════════════════

test("task-store promote-worker: sets worker_model_override", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    const result = run("promote-worker", {
      store: storePath,
      taskId: "TASK-001",
      model: "claude-sonnet-4-6",
    });
    assert.match(result, /^ok/, "promote-worker should succeed");

    const state = readState(storePath);
    assert.equal(
      state.tasks["TASK-001"].worker_model_override,
      "claude-sonnet-4-6",
      "model override should be recorded"
    );
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL — promotion ladder + early-promotion (M3 §3.4)
// ═══════════════════════════════════════════════════════════════════════════

test("task-store fail: three DIFFERENT errors → 3-strike promotion to sonnet", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    run("fail", { store: storePath, taskId: "TASK-001", reason: "parse error at line 1" });
    run("fail", { store: storePath, taskId: "TASK-001", reason: "type mismatch at line 7" });
    let st = readState(storePath);
    assert.equal(st.tasks["TASK-001"].worker_model_override, null, "no promote before strike 3 when errors differ");
    run("fail", { store: storePath, taskId: "TASK-001", reason: "missing import on line 12" });
    st = readState(storePath);
    assert.equal(st.tasks["TASK-001"].worker_model_override, "worker_promoted", "promoted at strike 3");
  } finally { rm(dir); }
});

test("task-store fail: two IDENTICAL normalized errors → early promotion before strike 3", () => {
  const dir = makeTempDir(TASKS);
  const storePath = path.join(dir, "store", "state.json");
  run("init", { store: storePath, manifestDir: dir });
  try {
    // Same underlying error, differing only in a timestamp/line number — should
    // normalize to the same signature and trigger early promotion on attempt 2.
    run("fail", { store: storePath, taskId: "TASK-001", reason: "err:contracts:symbol missing at line 4 t=2026-05-29T10:00:00Z" });
    run("fail", { store: storePath, taskId: "TASK-001", reason: "err:contracts:symbol missing at line 9 t=2026-05-29T10:05:00Z" });
    const st = readState(storePath);
    assert.equal(st.tasks["TASK-001"].worker_model_override, "worker_promoted", "early-promoted on identical normalized error");
    assert.equal(st.tasks["TASK-001"].retry_count, 0, "retry budget reset on promotion");
  } finally { rm(dir); }
});
