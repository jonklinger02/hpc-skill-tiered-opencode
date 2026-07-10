#!/usr/bin/env node
// Tests for execute.js pure helpers — concurrency ceiling (M3 §3.1),
// dependent counting (M3 §3.3), run-config resolution + counts (M4).
// Uses node:test. Does NOT run the execution loop (guarded by require.main).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { computeCeiling, countDependents, resolveRunConfig, readCounts } = require("./execute.js");

function mkTmp(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-exec-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── computeCeiling (M3 §3.1) ──
test("computeCeiling: returns a positive ceiling ≤ 250 with a named bound", () => {
  const { ceiling, limit } = computeCeiling();
  assert.ok(ceiling >= 1 && ceiling <= 250, `ceiling ${ceiling} in range`);
  assert.ok(["cpu", "memory", "hard-cap"].includes(limit), `limit=${limit}`);
});

// ── countDependents (M3 §3.3) ──
test("countDependents: counts tasks listing the target in depends_on", () => {
  const dir = mkTmp({
    "tasks/TASK-A.yaml": "task_id: TASK-A\ndepends_on: []",
    "tasks/TASK-B.yaml": "task_id: TASK-B\ndepends_on:\n  - TASK-A",
    "tasks/TASK-C.yaml": "task_id: TASK-C\ndepends_on:\n  - TASK-A\n  - TASK-B",
  });
  try {
    assert.equal(countDependents(dir, "TASK-A"), 2);
    assert.equal(countDependents(dir, "TASK-B"), 1);
    assert.equal(countDependents(dir, "TASK-C"), 0);
  } finally { rm(dir); }
});

// ── resolveRunConfig (M4) ──
test("resolveRunConfig: defaults are autonomy-off (behavior preserved)", () => {
  const c = resolveRunConfig({});
  assert.equal(c.autoContinue, false);
  assert.equal(c.heartbeat, false);
  assert.equal(c.abortThreshold, 0.70);
  assert.equal(c.maxRunCount, 50);
});

test("resolveRunConfig: --auto-continue turns on heartbeat too", () => {
  const c = resolveRunConfig({ autoContinue: true });
  assert.equal(c.autoContinue, true);
  assert.equal(c.heartbeat, true);
});

test("resolveRunConfig: reads a run-config file; CLI overrides win", () => {
  const dir = mkTmp({
    "run-config.yaml": "run_config:\n  auto_continue: true\n  cooloff_minutes: 5\n  abort_threshold: 0.5\n  max_run_count: 9\n",
  });
  try {
    const fromFile = resolveRunConfig({ runConfig: path.join(dir, "run-config.yaml") });
    assert.equal(fromFile.autoContinue, true);
    assert.equal(fromFile.cooloffMin, 5);
    assert.equal(fromFile.abortThreshold, 0.5);
    assert.equal(fromFile.maxRunCount, 9);
    // CLI override beats the file value
    const overridden = resolveRunConfig({ runConfig: path.join(dir, "run-config.yaml"), maxRunCount: 3 });
    assert.equal(overridden.maxRunCount, 3);
  } finally { rm(dir); }
});

// ── readCounts (M4 heartbeat/watchdog) ──
test("readCounts: tallies task statuses from the store", () => {
  const dir = mkTmp({
    "state.json": JSON.stringify({ tasks: {
      A: { status: "COMPLETE" }, B: { status: "COMPLETE" },
      C: { status: "BLOCKED" }, D: { status: "PLANNED" },
    } }),
  });
  try {
    const c = readCounts(path.join(dir, "state.json"));
    assert.equal(c.COMPLETE, 2);
    assert.equal(c.BLOCKED, 1);
    assert.equal(c.PLANNED, 1);
    assert.equal(c.total, 4);
  } finally { rm(dir); }
});
