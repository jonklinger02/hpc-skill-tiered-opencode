#!/usr/bin/env node
// Tests for dag.js — cycle detection, topological sort, next-batch, cascade-block,
// ancestors, descendants, and the blockage-report path.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node dag.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAG_SCRIPT = path.resolve(__dirname, "dag.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-dag-test-"));
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

/** Run dag.js with extra args and return trimmed stdout. Never throws. */
function runDag(extraArgs, manifestDir) {
  try {
    return execSync(
      `node "${DAG_SCRIPT}" --manifest-dir "${manifestDir}" ${extraArgs}`,
      { encoding: "utf-8" }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/** Write a state.json and return its path. */
function writeState(dir, tasksMap) {
  const state = { tasks: {} };
  for (const [id, status] of Object.entries(tasksMap)) {
    state.tasks[id] = { status };
  }
  const p = path.join(dir, "state.json");
  fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

// ── Fixture task YAMLs ────────────────────────────────────────────────────
// dag.js parses both block-form lists (`depends_on:\n  - X`) and the inline
// council-output form (`depends_on: ["X", "Y"]`); a final block item without
// a trailing \n is tolerated.

// Linear chain: A (no deps) → B (depends A) → C (depends B)
const TASK_A = "task_id: TASK-001\ndepends_on: []\n";
const TASK_B = "task_id: TASK-002\ndepends_on:\n  - TASK-001\n";
const TASK_C = "task_id: TASK-003\ndepends_on:\n  - TASK-002\n";

// Cyclic: A depends on C, creating A→B→C→A
const TASK_A_CYCLIC = "task_id: TASK-001\ndepends_on:\n  - TASK-003\n";

// Diamond: A → B, A → C, B → D, C → D
const TASK_D = "task_id: TASK-004\ndepends_on:\n  - TASK-002\n  - TASK-003\n";
const TASK_B_DIAMOND = "task_id: TASK-002\ndepends_on:\n  - TASK-001\n";
const TASK_C_DIAMOND = "task_id: TASK-003\ndepends_on:\n  - TASK-001\n";

// ═══════════════════════════════════════════════════════════════════════════
// CYCLE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: acyclic linear chain → ok", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    assert.equal(runDag("--check-cycles", dir), "ok");
  } finally { rm(dir); }
});

test("DAG: acyclic diamond → ok", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B_DIAMOND,
    "tasks/TASK-003.yaml": TASK_C_DIAMOND,
    "tasks/TASK-004.yaml": TASK_D,
  });
  try {
    assert.equal(runDag("--check-cycles", dir), "ok");
  } finally { rm(dir); }
});

test("DAG: cyclic graph → err:cycles_detected", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A_CYCLIC,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const result = runDag("--check-cycles", dir);
    assert.match(result, /err:cycles_detected/);
  } finally { rm(dir); }
});

test("DAG: single node with no deps → ok (no cycle possible)", () => {
  const dir = makeTempDir({ "tasks/TASK-001.yaml": TASK_A });
  try {
    assert.equal(runDag("--check-cycles", dir), "ok");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOPOLOGICAL SORT
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: topo-sort linear chain — A before B before C", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const raw = runDag("--topo-sort", dir);
    const order = JSON.parse(raw);
    const idx = (id) => order.indexOf(id);
    assert.ok(idx("TASK-001") < idx("TASK-002"), "A must precede B");
    assert.ok(idx("TASK-002") < idx("TASK-003"), "B must precede C");
  } finally { rm(dir); }
});

test("DAG: topo-sort diamond — A before B and C, both before D", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B_DIAMOND,
    "tasks/TASK-003.yaml": TASK_C_DIAMOND,
    "tasks/TASK-004.yaml": TASK_D,
  });
  try {
    const raw = runDag("--topo-sort", dir);
    const order = JSON.parse(raw);
    const idx = (id) => order.indexOf(id);
    assert.ok(idx("TASK-001") < idx("TASK-002"), "A before B");
    assert.ok(idx("TASK-001") < idx("TASK-003"), "A before C");
    assert.ok(idx("TASK-002") < idx("TASK-004"), "B before D");
    assert.ok(idx("TASK-003") < idx("TASK-004"), "C before D");
  } finally { rm(dir); }
});

test("DAG: topo-sort on cyclic graph → err", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A_CYCLIC,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const result = runDag("--topo-sort", dir);
    assert.match(result, /err:/);
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// NEXT-BATCH
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: next-batch — A complete, B eligible, C not yet eligible", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "COMPLETE",
      "TASK-002": "PLANNED",
      "TASK-003": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.ok(batch.includes("TASK-002"), "TASK-002 should be eligible (dep COMPLETE)");
    assert.ok(!batch.includes("TASK-003"), "TASK-003 should not be eligible (dep PLANNED)");
    assert.ok(!batch.includes("TASK-001"), "TASK-001 is already COMPLETE");
  } finally { rm(dir); }
});

test("DAG: next-batch — root tasks (no deps) are immediately eligible when PLANNED", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "PLANNED",
      "TASK-002": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.ok(batch.includes("TASK-001"), "root task TASK-001 should be in first batch");
    assert.ok(!batch.includes("TASK-002"), "TASK-002 blocked on TASK-001");
  } finally { rm(dir); }
});

test("DAG: next-batch — LOCKED dep does not unblock downstream", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "LOCKED",
      "TASK-002": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.ok(!batch.includes("TASK-002"), "TASK-002 should not be eligible while dep is LOCKED");
  } finally { rm(dir); }
});

test("DAG: next-batch — empty when everything is COMPLETE", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "COMPLETE",
      "TASK-002": "COMPLETE",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.equal(batch.length, 0, "no tasks left to run");
  } finally { rm(dir); }
});

test("DAG: next-batch — diamond all eligible after root completes", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B_DIAMOND,
    "tasks/TASK-003.yaml": TASK_C_DIAMOND,
    "tasks/TASK-004.yaml": TASK_D,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "COMPLETE",
      "TASK-002": "PLANNED",
      "TASK-003": "PLANNED",
      "TASK-004": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.ok(batch.includes("TASK-002"), "B eligible after A completes");
    assert.ok(batch.includes("TASK-003"), "C eligible after A completes");
    assert.ok(!batch.includes("TASK-004"), "D blocked on B and C");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// INLINE depends_on (council output format)
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: inline depends_on — next-batch withholds consumer until producer COMPLETE", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": 'task_id: TASK-001\ndepends_on: []\n',
    "tasks/TASK-002.yaml": 'task_id: TASK-002\ndepends_on: ["TASK-001"]\n',
    "tasks/TASK-003.yaml": "task_id: TASK-003\ndepends_on: ['TASK-001', 'TASK-002']\n",
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "PLANNED",
      "TASK-002": "PLANNED",
      "TASK-003": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.deepEqual(batch, ["TASK-001"], "only the producer is eligible — inline deps must yield edges");
  } finally { rm(dir); }
});

test("DAG: inline depends_on — cycle detected", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": 'task_id: TASK-001\ndepends_on: ["TASK-002"]\n',
    "tasks/TASK-002.yaml": 'task_id: TASK-002\ndepends_on: ["TASK-001"]\n',
  });
  try {
    const result = runDag("--check-cycles", dir);
    assert.match(result, /err:cycles_detected/, "inline-form cycle must be detected");
  } finally { rm(dir); }
});

test("DAG: inline empty list depends_on: [] yields no edges", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": "task_id: TASK-001\ndepends_on: []\n",
    "tasks/TASK-002.yaml": "task_id: TASK-002\ndepends_on: []\n",
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "PLANNED",
      "TASK-002": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.deepEqual(batch.sort(), ["TASK-001", "TASK-002"], "both roots eligible");
  } finally { rm(dir); }
});

test("DAG: block-form final item without trailing newline is still parsed", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": "task_id: TASK-001\ndepends_on: []\n",
    "tasks/TASK-002.yaml": "task_id: TASK-002\ndepends_on:\n  - TASK-001", // no trailing \n
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "PLANNED",
      "TASK-002": "PLANNED",
    });
    const batch = JSON.parse(runDag(`--next-batch "${stateFile}"`, dir));
    assert.ok(!batch.includes("TASK-002"), "TASK-002 must wait on TASK-001 even without trailing newline");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CASCADE-BLOCK
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: cascade-block from A affects B and C (chain)", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "BLOCKED",
      "TASK-002": "PLANNED",
      "TASK-003": "PLANNED",
    });
    const affected = JSON.parse(
      runDag(`--cascade-block "${stateFile}" TASK-001`, dir)
    );
    assert.ok(affected.includes("TASK-002"), "TASK-002 is a downstream victim");
    assert.ok(affected.includes("TASK-003"), "TASK-003 is a downstream victim");
  } finally { rm(dir); }
});

test("DAG: cascade-block from B only affects C (not A)", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "COMPLETE",
      "TASK-002": "BLOCKED",
      "TASK-003": "PLANNED",
    });
    const affected = JSON.parse(
      runDag(`--cascade-block "${stateFile}" TASK-002`, dir)
    );
    assert.ok(affected.includes("TASK-003"), "TASK-003 is downstream of B");
    assert.ok(!affected.includes("TASK-001"), "TASK-001 is upstream — should not be cascaded");
  } finally { rm(dir); }
});

test("DAG: cascade-block on leaf node returns empty list", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const stateFile = writeState(dir, {
      "TASK-001": "COMPLETE",
      "TASK-002": "COMPLETE",
      "TASK-003": "BLOCKED",
    });
    const affected = JSON.parse(
      runDag(`--cascade-block "${stateFile}" TASK-003`, dir)
    );
    assert.equal(affected.length, 0, "leaf has no downstream dependents");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ANCESTORS / DESCENDANTS
// ═══════════════════════════════════════════════════════════════════════════

test("DAG: ancestors of C are A and B", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const ancs = JSON.parse(runDag("--ancestors TASK-003", dir));
    assert.ok(ancs.includes("TASK-001"), "A is an ancestor of C");
    assert.ok(ancs.includes("TASK-002"), "B is an ancestor of C");
    assert.ok(!ancs.includes("TASK-003"), "C is not its own ancestor");
  } finally { rm(dir); }
});

test("DAG: descendants of A are B and C", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
    "tasks/TASK-003.yaml": TASK_C,
  });
  try {
    const descs = JSON.parse(runDag("--descendants TASK-001", dir));
    assert.ok(descs.includes("TASK-002"), "B is a descendant of A");
    assert.ok(descs.includes("TASK-003"), "C is a descendant of A");
    assert.ok(!descs.includes("TASK-001"), "A is not its own descendant");
  } finally { rm(dir); }
});

test("DAG: root node has no ancestors", () => {
  const dir = makeTempDir({
    "tasks/TASK-001.yaml": TASK_A,
    "tasks/TASK-002.yaml": TASK_B,
  });
  try {
    const ancs = JSON.parse(runDag("--ancestors TASK-001", dir));
    assert.equal(ancs.length, 0, "root has no ancestors");
  } finally { rm(dir); }
});
