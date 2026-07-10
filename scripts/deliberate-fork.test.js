#!/usr/bin/env node
// Tests for deliberate-fork.js pure recovery-tier helpers (M5 §5.6).
// The council deliberation itself needs the API; these cover the decision logic.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  recoveryTierFromCouncil, nextTier, councilForTier,
  diffGuardThreshold, computeDiffGuard, sliceHash, manifestHash, countManifestTasks,
} = require("./deliberate-fork.js");

test("recoveryTierFromCouncil: director→2, csuite→3, explicit wins", () => {
  assert.equal(recoveryTierFromCouncil("director"), 2);
  assert.equal(recoveryTierFromCouncil("csuite"), 3);
  assert.equal(recoveryTierFromCouncil("director", "4"), 4);
});

test("nextTier: increments, clamps at 5", () => {
  assert.equal(nextTier(2), 3);
  assert.equal(nextTier(4), 5);
  assert.equal(nextTier(5), 5);
});

test("councilForTier: ≥3 is csuite", () => {
  assert.equal(councilForTier(2), "director");
  assert.equal(councilForTier(3), "csuite");
  assert.equal(councilForTier(4), "csuite");
});

test("diffGuardThreshold: 30% Tier2, 60% Tier3+", () => {
  assert.equal(diffGuardThreshold(2), 0.30);
  assert.equal(diffGuardThreshold(3), 0.60);
  assert.equal(diffGuardThreshold(4), 0.60);
});

test("computeDiffGuard: Tier2 trips at >30%, Tier3 tolerates up to 60%", () => {
  assert.equal(computeDiffGuard(4, 10, 2).exceeded, true);  // 40% > 30%
  assert.equal(computeDiffGuard(4, 10, 3).exceeded, false); // 40% < 60%
  assert.equal(computeDiffGuard(7, 10, 3).exceeded, true);  // 70% > 60%
  assert.equal(computeDiffGuard(0, 0, 2).exceeded, false);  // no tasks → no trip
});

test("sliceHash: order-independent + stable prefix", () => {
  assert.equal(sliceHash(["B", "A", "C"]), sliceHash(["A", "B", "C"]));
  assert.match(sliceHash(["A"]), /^S-[0-9a-f]{12}$/);
});

test("manifestHash + countManifestTasks reflect manifest content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-df-test-"));
  try {
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tasks", "TASK-A.yaml"), "task_id: TASK-A\n");
    fs.writeFileSync(path.join(dir, "tasks", "TASK-B.yaml"), "task_id: TASK-B\n");
    assert.equal(countManifestTasks(dir), 2);
    const h1 = manifestHash(dir);
    assert.match(h1, /^MH-[0-9a-f]{12}$/);
    // Changing content changes the hash.
    fs.writeFileSync(path.join(dir, "tasks", "TASK-A.yaml"), "task_id: TASK-A\nchanged: true\n");
    assert.notEqual(manifestHash(dir), h1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
