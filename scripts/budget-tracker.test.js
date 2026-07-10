#!/usr/bin/env node
/**
 * budget-tracker.test.js — Tests for budget-tracker.js
 *
 * Tests:
 * - Small, medium, and large builds with expected cap values
 * - Complexity bonus computation
 * - Override precedence (--override > run_config > inferred)
 * - State file parsing and used iteration counting
 * - Absolute cap clamping to 15
 * - Budget report YAML generation
 * - Halt signal when cap is reached
 *
 * Run via:  node scripts/budget-tracker.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "budget-tracker.js");

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temporary manifest directory with tasks/ and contracts/ subdirs.
 * files: { relPath -> content }
 */
function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-budget-test-"));
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
 * Run budget-tracker with given args. Returns { stdout, code, report }.
 */
function runBudgetTracker(manifestDir, extraArgs = "") {
  const outputPath = path.join(manifestDir, "..", "wiki", "budget-report.yaml");
  try {
    const stdout = execSync(
      `node "${SCRIPT}" --manifest-dir "${manifestDir}" ${extraArgs}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return {
      stdout,
      code: 0,
      report: fs.existsSync(outputPath)
        ? yaml.load(fs.readFileSync(outputPath, "utf-8"))
        : null,
    };
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    return {
      stdout,
      code: e.status || 1,
      report: fs.existsSync(outputPath)
        ? yaml.load(fs.readFileSync(outputPath, "utf-8"))
        : null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test("small build (3 tasks, 1 contract) → cap=3, size=small", (t) => {
  const dir = makeTempDir({
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
    "tasks/task-2.yaml": "task_id: TASK-UI-0002\n",
    "tasks/task-3.yaml": "task_id: TASK-UI-0003\n",
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  });

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=3/);
    assert.match(result.stdout, /size=small/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 3);
    assert.strictEqual(result.report.size, "small");
    assert.strictEqual(result.report.used, 0);
    assert.strictEqual(result.report.remaining, 3);
  } finally {
    rm(dir);
  }
});

test("medium build (100 tasks, 10 contracts) → cap=5, size=medium", (t) => {
  const files = {
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
    "contracts/contract-2.yaml": "contract_id: CONTRACT-API-02\n",
    "contracts/contract-3.yaml": "contract_id: CONTRACT-API-03\n",
    "contracts/contract-4.yaml": "contract_id: CONTRACT-API-04\n",
    "contracts/contract-5.yaml": "contract_id: CONTRACT-API-05\n",
    "contracts/contract-6.yaml": "contract_id: CONTRACT-API-06\n",
    "contracts/contract-7.yaml": "contract_id: CONTRACT-API-07\n",
    "contracts/contract-8.yaml": "contract_id: CONTRACT-API-08\n",
    "contracts/contract-9.yaml": "contract_id: CONTRACT-API-09\n",
    "contracts/contract-10.yaml": "contract_id: CONTRACT-API-10\n",
  };

  for (let i = 1; i <= 100; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=5/);
    assert.match(result.stdout, /size=medium/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 5);
    assert.strictEqual(result.report.size, "medium");
  } finally {
    rm(dir);
  }
});

test("large build (>200 tasks) → cap >= 10, size=large", (t) => {
  const files = {};

  for (let i = 1; i <= 210; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=/);
    assert.match(result.stdout, /size=large/);
    assert(result.report);
    assert(result.report.cap >= 10);
    assert.strictEqual(result.report.size, "large");
  } finally {
    rm(dir);
  }
});

test("large build (>20 contracts) → cap >= 10, size=large", (t) => {
  const files = {
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
  };

  for (let i = 1; i <= 25; i++) {
    files[`contracts/contract-${i}.yaml`] = `contract_id: CONTRACT-API-${String(
      i
    ).padStart(2, "0")}\n`;
  }

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=/);
    assert.match(result.stdout, /size=large/);
    assert(result.report);
    assert(result.report.cap >= 10);
    assert.strictEqual(result.report.size, "large");
  } finally {
    rm(dir);
  }
});

test("--override 7 → cap=7 regardless of size", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir, "--override 7");
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=7/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 7);
  } finally {
    rm(dir);
  }
});

test("--override 99 → cap=15 (clamped to absolute cap)", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir, "--override 99");
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=15/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 15);
  } finally {
    rm(dir);
  }
});

test("--run-config with recovery_iteration_cap_override: 9 → cap=9", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);
  const runConfigFile = path.join(dir, "run-config.yaml");
  fs.writeFileSync(
    runConfigFile,
    `run_config:\n  recovery_iteration_cap_override: 9\n`
  );

  try {
    const result = runBudgetTracker(
      dir,
      `--run-config "${runConfigFile}"`
    );
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=9/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 9);
  } finally {
    rm(dir);
  }
});

test("--state file with 3 iterations and small build (cap 3) → halt:cap_reached", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);
  const stateFile = path.join(dir, "..", "wiki", "recovery-state.yaml");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `iterations:\n  - run_id: run-1\n  - run_id: run-2\n  - run_id: run-3\n`);

  try {
    const result = runBudgetTracker(dir, `--state "${stateFile}"`);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /halt:cap_reached:cap=3 used=3/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 3);
    assert.strictEqual(result.report.used, 3);
  } finally {
    rm(dir);
  }
});

test("--state with top-level list → used count", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);
  const stateFile = path.join(dir, "..", "wiki", "recovery-state.yaml");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `- run_id: run-1\n- run_id: run-2\n`);

  try {
    const result = runBudgetTracker(dir, `--state "${stateFile}"`);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=3 used=2 remaining=1/);
    assert(result.report);
    assert.strictEqual(result.report.used, 2);
    assert.strictEqual(result.report.remaining, 1);
  } finally {
    rm(dir);
  }
});

test("override precedence: --override > --run-config > inferred", (t) => {
  const files = {};
  for (let i = 1; i <= 3; i++) {
    files[`tasks/task-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);
  const runConfigFile = path.join(dir, "run-config.yaml");
  fs.writeFileSync(
    runConfigFile,
    `run_config:\n  recovery_iteration_cap_override: 8\n`
  );

  try {
    // --override should take precedence
    const result = runBudgetTracker(
      dir,
      `--override 7 --run-config "${runConfigFile}"`
    );
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /ok:cap=7/);
    assert(result.report);
    assert.strictEqual(result.report.cap, 7);
  } finally {
    rm(dir);
  }
});

test("complexity bonus: integrDataEvalShare > 0.30 → +2", (t) => {
  const files = {};
  // Create 10 tasks: 4 INTEG, rest UI (40% INTEG > 30%)
  for (let i = 1; i <= 4; i++) {
    files[`tasks/task-integ-${i}.yaml`] = `task_id: TASK-INTEG-${String(
      i
    ).padStart(4, "0")}\n`;
  }
  for (let i = 5; i <= 10; i++) {
    files[`tasks/task-ui-${i}.yaml`] = `task_id: TASK-UI-${String(i).padStart(
      4,
      "0"
    )}\n`;
  }
  files["contracts/contract-1.yaml"] = "contract_id: CONTRACT-API-01\n";

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert(result.report);
    // Base is 3 (small), +2 for integrDataEvalShare > 0.30 = 5
    assert.strictEqual(result.report.cap, 5);
    assert.strictEqual(result.report.bonuses, 2);
  } finally {
    rm(dir);
  }
});

test("complexity bonus: crossPackageDependencyDensity > 0.50 → +2", (t) => {
  const files = {
    "tasks/task-1.yaml": `task_id: TASK-INTEG-0001
depends_on:
  - TASK-DATA-0001
  - TASK-DATA-0002
`,
    "tasks/task-2.yaml": `task_id: TASK-DATA-0001
depends_on:
  - TASK-EVAL-0001
`,
    "tasks/task-3.yaml": `task_id: TASK-DATA-0002
`,
    "tasks/task-4.yaml": `task_id: TASK-EVAL-0001
`,
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert(result.report);
    // 3 depends_on edges, all 3 are cross-area (INTEG->DATA, INTEG->DATA, DATA->EVAL)
    // density = 3/3 = 1.0 > 0.5 → +2
    // Base is 3 (small) + 2 = 5
    assert(result.report.cap >= 5);
  } finally {
    rm(dir);
  }
});

test("budget-report.yaml is created and has required fields", (t) => {
  const files = {
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert(result.report);
    assert(result.report.cap !== undefined);
    assert(result.report.used !== undefined);
    assert(result.report.remaining !== undefined);
    assert(result.report.base !== undefined);
    assert(result.report.bonuses !== undefined);
    assert(result.report.size !== undefined);
    assert(result.report.proxies !== undefined);
    assert(result.report.proxies.integrDataEvalShare !== undefined);
    assert(result.report.proxies.crossPackageDependencyDensity !== undefined);
  } finally {
    rm(dir);
  }
});

test("no --state → used=0, remaining=cap", (t) => {
  const files = {
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
    "tasks/task-2.yaml": "task_id: TASK-UI-0002\n",
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /used=0 remaining=3/);
    assert(result.report);
    assert.strictEqual(result.report.used, 0);
    assert.strictEqual(result.report.remaining, 3);
  } finally {
    rm(dir);
  }
});

test("ok output when remaining > 0", (t) => {
  const files = {
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
    "tasks/task-2.yaml": "task_id: TASK-UI-0002\n",
    "tasks/task-3.yaml": "task_id: TASK-UI-0003\n",
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);
  const stateFile = path.join(dir, "..", "wiki", "recovery-state.yaml");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `iterations:\n  - run_id: run-1\n`);

  try {
    const result = runBudgetTracker(dir, `--state "${stateFile}"`);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /^ok:/);
    assert.match(result.stdout, /cap=3 used=1 remaining=2/);
  } finally {
    rm(dir);
  }
});

test("functional_area field is recognized for INTEG/DATA/EVAL", (t) => {
  const files = {
    "tasks/task-1.yaml": `task_id: TASK-UI-0001
functional_area: data
`,
    "tasks/task-2.yaml": `task_id: TASK-UI-0002
functional_area: integ
`,
    "tasks/task-3.yaml": `task_id: TASK-UI-0003
`,
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);

  try {
    const result = runBudgetTracker(dir);
    assert.strictEqual(result.code, 0);
    assert(result.report);
    // 2 out of 3 tasks are DATA or INTEG: 66.7% > 30% → +2
    // Base is 3 (small) + 2 = 5
    assert.strictEqual(result.report.cap, 5);
  } finally {
    rm(dir);
  }
});

test("empty state file → used=0", (t) => {
  const files = {
    "tasks/task-1.yaml": "task_id: TASK-UI-0001\n",
    "contracts/contract-1.yaml": "contract_id: CONTRACT-API-01\n",
  };

  const dir = makeTempDir(files);
  const stateFile = path.join(dir, "..", "wiki", "recovery-state.yaml");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "iterations: []\n");

  try {
    const result = runBudgetTracker(dir, `--state "${stateFile}"`);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /used=0/);
  } finally {
    rm(dir);
  }
});
