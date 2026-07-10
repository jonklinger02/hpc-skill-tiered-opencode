#!/usr/bin/env node
/**
 * plan-preflight.test.js — Tests for plan-preflight.js
 *
 * Tests contract resolution, symbol validation, known gaps, and parse error handling.
 *
 * Run via:  node scripts/plan-preflight.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "plan-preflight.js");

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temporary manifest directory with tasks/ and contracts/ subdirs.
 * files: { relPath -> content }
 */
function makeTempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-preflight-test-"));
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
 * Run plan-preflight with given args. Returns { stdout, stderr, code, report }.
 * report is the parsed YAML from the output file if it exists.
 */
function runPreflight(manifestDir, extraArgs = "") {
  const outputPath = path.join(manifestDir, "..", "wiki", "plan-preflight-report.yaml");
  try {
    const stdout = execSync(
      `node "${SCRIPT}" --manifest-dir "${manifestDir}" ${extraArgs}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return {
      stdout,
      stderr: "",
      code: 0,
      report: fs.existsSync(outputPath)
        ? yaml.load(fs.readFileSync(outputPath, "utf-8"))
        : null,
    };
  } catch (e) {
    const stdout = (e.stdout || "").trim();
    const stderr = (e.stderr || "").trim();
    return {
      stdout,
      stderr,
      code: e.status || 1,
      report: fs.existsSync(outputPath)
        ? yaml.load(fs.readFileSync(outputPath, "utf-8"))
        : null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures: YAML content
// ─────────────────────────────────────────────────────────────────────────────

// A contract that defines a surface
const CONTRACT_DB = `
contract_id: CONTRACT-DB-01
name: Database Service
surface:
  - name: JobStore.list
    kind: method
  - name: JobStore.get
    kind: method
`;

// Another contract
const CONTRACT_API = `
contract_id: CONTRACT-API-01
name: REST API Service
surface:
  - name: POST /users
    kind: endpoint
  - name: GET /users/{id}
    kind: endpoint
`;

// Task that consumes a contract (structured form with invokes)
const TASK_CONSUMER_STRUCTURED = `
task_id: TASK-CONSUMER-01
description: Consumes DB contract
contracts_consumed:
  - contract_id: CONTRACT-DB-01
    invokes:
      - JobStore.list
      - JobStore.get
`;

// Task that produces a contract (structured form with implements)
const TASK_PRODUCER_STRUCTURED = `
task_id: TASK-PRODUCER-01
description: Produces DB contract
contracts_produced:
  - contract_id: CONTRACT-DB-01
    implements:
      - JobStore.list
      - JobStore.get
`;

// Task that consumes a contract (legacy flat form, no invokes)
const TASK_CONSUMER_LEGACY = `
task_id: TASK-CONSUMER-02
description: Legacy consumer
contracts_consumed:
  - CONTRACT-API-01
`;

// Task that consumes a contract but invokes a missing symbol
const TASK_CONSUMER_MISSING_SYMBOL = `
task_id: TASK-CONSUMER-MISSING-SYM
description: Consumes and invokes missing symbol
contracts_consumed:
  - contract_id: CONTRACT-DB-01
    invokes:
      - JobStore.list
      - JobStore.missing_method
`;

// Task that produces a contract
const TASK_PRODUCER_API = `
task_id: TASK-PRODUCER-API-01
description: Produces API contract
contracts_produced:
  - contract_id: CONTRACT-API-01
    implements:
      - POST /users
      - GET /users/{id}
`;

// Task with known_gap flag
const TASK_WITH_KNOWN_GAP = `
task_id: TASK-KNOWN-GAP-01
description: Consumer with known gap
known_gap: true
known_gap_reason: Deferred to phase 2
contracts_consumed:
  - contract_id: CONTRACT-MISSING-LATER
    invokes:
      - SomeMethod
`;

// Task with known_gap but no reason
const TASK_WITH_KNOWN_GAP_NO_REASON = `
task_id: TASK-KNOWN-GAP-02
description: Consumer with known gap, no reason
known_gap: true
contracts_consumed:
  - contract_id: CONTRACT-MISSING-LATER-2
`;

// ═════════════════════════════════════════════════════════════════════════════
// Test cases
// ═════════════════════════════════════════════════════════════════════════════

test("Clean case: producer implements consumed symbol → ok, 0 unresolved", () => {
  const dir = makeTempDir({
    "tasks/TASK-CONSUMER-01.yaml": TASK_CONSUMER_STRUCTURED,
    "tasks/TASK-PRODUCER-01.yaml": TASK_PRODUCER_STRUCTURED,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_contracts, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
    assert.equal(result.report.unresolved.length, 0);
  } finally {
    rm(dir);
  }
});

test("Missing producer contract → err, contract finding", () => {
  const dir = makeTempDir({
    "tasks/TASK-CONSUMER-01.yaml": TASK_CONSUMER_STRUCTURED,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^err:/);
    assert.equal(result.code, 1);
    assert.equal(result.report.summary.unresolved_contracts, 1);
    const contractUnresolved = result.report.unresolved.filter(f => f.kind === "contract");
    assert.equal(contractUnresolved.length, 1);
    assert.equal(contractUnresolved[0].contract_id, "CONTRACT-DB-01");
    assert.equal(contractUnresolved[0].consumer_task, "TASK-CONSUMER-01");
    assert.strictEqual(contractUnresolved[0].symbol, null);
  } finally {
    rm(dir);
  }
});

test("Consumed symbol not implemented by producer → err, symbol finding", () => {
  const dir = makeTempDir({
    "tasks/TASK-CONSUMER-MISSING-SYM.yaml": TASK_CONSUMER_MISSING_SYMBOL,
    "tasks/TASK-PRODUCER-01.yaml": TASK_PRODUCER_STRUCTURED,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^err:/);
    assert.equal(result.code, 1);
    assert.equal(result.report.summary.unresolved_symbols, 1);
    const symbolUnresolved = result.report.unresolved.filter(f => f.kind === "symbol");
    assert.equal(symbolUnresolved.length, 1);
    assert.equal(symbolUnresolved[0].contract_id, "CONTRACT-DB-01");
    assert.equal(symbolUnresolved[0].symbol, "JobStore.missing_method");
    assert.equal(symbolUnresolved[0].consumer_task, "TASK-CONSUMER-MISSING-SYM");
  } finally {
    rm(dir);
  }
});

test("known_gap: true suppresses contract block → ok, finding in known_gaps", () => {
  const dir = makeTempDir({
    "tasks/TASK-KNOWN-GAP-01.yaml": TASK_WITH_KNOWN_GAP,
    "contracts/CONTRACT-MISSING-LATER.yaml": "contract_id: CONTRACT-MISSING-LATER\n",
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_contracts, 0);
    assert.equal(result.report.summary.known_gaps, 1);
    assert.equal(result.report.known_gaps.length, 1);
    assert.equal(result.report.known_gaps[0].contract_id, "CONTRACT-MISSING-LATER");
    assert.equal(result.report.known_gaps[0].reason, "Deferred to phase 2");
  } finally {
    rm(dir);
  }
});

test("known_gap: true with missing reason → reason defaults to 'known gap'", () => {
  const dir = makeTempDir({
    "tasks/TASK-KNOWN-GAP-02.yaml": TASK_WITH_KNOWN_GAP_NO_REASON,
    "contracts/CONTRACT-MISSING-LATER-2.yaml": "contract_id: CONTRACT-MISSING-LATER-2\n",
  });

  try {
    const result = runPreflight(dir);
    assert.equal(result.code, 0);
    assert.equal(result.report.known_gaps.length, 1);
    assert.equal(result.report.known_gaps[0].reason, "known gap");
  } finally {
    rm(dir);
  }
});

test("Legacy flat-string refs (no invokes/implements) → contract-level resolution, no symbol checks", () => {
  const dir = makeTempDir({
    "tasks/TASK-CONSUMER-02.yaml": TASK_CONSUMER_LEGACY,
    "tasks/TASK-PRODUCER-API-01.yaml": TASK_PRODUCER_API,
    "contracts/CONTRACT-API-01.yaml": CONTRACT_API,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_contracts, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
  } finally {
    rm(dir);
  }
});

test("Parse error in task file → recorded under parse_errors, no crash", () => {
  const dir = makeTempDir({
    "tasks/TASK-BAD.yaml": "{ invalid yaml content {{",
    "tasks/TASK-GOOD.yaml": "task_id: TASK-GOOD\n",
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.report.summary.parse_errors, 1);
    assert(result.report.parse_errors.includes("TASK-BAD.yaml"));
  } finally {
    rm(dir);
  }
});

test("Parse error in contract file → recorded under parse_errors, no crash", () => {
  const dir = makeTempDir({
    "contracts/CONTRACT-BAD.yaml": "{ broken yaml [[[",
    "contracts/CONTRACT-GOOD.yaml": "contract_id: CONTRACT-GOOD\n",
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.report.summary.parse_errors, 1);
    assert(result.report.parse_errors.includes("CONTRACT-BAD.yaml"));
  } finally {
    rm(dir);
  }
});

test("Bare symbol matching: 'POST /users' in surface, invokes '/users' → matches", () => {
  const CONTRACT_WITH_HTTP = `
contract_id: CONTRACT-HTTP-01
surface:
  - name: POST /users
    kind: endpoint
  - name: GET /users/{id}
    kind: endpoint
`;

  const TASK_INVOKE_BARE = `
task_id: TASK-INVOKE-BARE
contracts_consumed:
  - contract_id: CONTRACT-HTTP-01
    invokes:
      - /users
`;

  const TASK_PRODUCE_HTTP = `
task_id: TASK-PRODUCE-HTTP
contracts_produced:
  - contract_id: CONTRACT-HTTP-01
    implements:
      - POST /users
      - GET /users/{id}
`;

  const dir = makeTempDir({
    "tasks/TASK-INVOKE-BARE.yaml": TASK_INVOKE_BARE,
    "tasks/TASK-PRODUCE-HTTP.yaml": TASK_PRODUCE_HTTP,
    "contracts/CONTRACT-HTTP-01.yaml": CONTRACT_WITH_HTTP,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
  } finally {
    rm(dir);
  }
});

test("Multiple producers for same contract → symbol resolved if any implements it", () => {
  const TASK_PRODUCER_A = `
task_id: TASK-PRODUCER-A
contracts_produced:
  - contract_id: CONTRACT-MULTI-01
    implements:
      - JobStore.list
`;

  const TASK_PRODUCER_B = `
task_id: TASK-PRODUCER-B
contracts_produced:
  - contract_id: CONTRACT-MULTI-01
    implements:
      - JobStore.get
`;

  const TASK_CONSUMER_BOTH = `
task_id: TASK-CONSUMER-BOTH
contracts_consumed:
  - contract_id: CONTRACT-MULTI-01
    invokes:
      - JobStore.list
      - JobStore.get
`;

  const CONTRACT_MULTI = `
contract_id: CONTRACT-MULTI-01
surface:
  - name: JobStore.list
  - name: JobStore.get
`;

  const dir = makeTempDir({
    "tasks/TASK-PRODUCER-A.yaml": TASK_PRODUCER_A,
    "tasks/TASK-PRODUCER-B.yaml": TASK_PRODUCER_B,
    "tasks/TASK-CONSUMER-BOTH.yaml": TASK_CONSUMER_BOTH,
    "contracts/CONTRACT-MULTI-01.yaml": CONTRACT_MULTI,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
  } finally {
    rm(dir);
  }
});

test("Default output path: <manifest-dir>/../wiki/plan-preflight-report.yaml", () => {
  const dir = makeTempDir({
    "tasks/TASK-GOOD.yaml": "task_id: TASK-GOOD\n",
  });

  try {
    runPreflight(dir);
    const defaultPath = path.join(dir, "..", "wiki", "plan-preflight-report.yaml");
    assert(fs.existsSync(defaultPath), `Report should exist at ${defaultPath}`);
  } finally {
    rm(dir);
  }
});

test("Custom output path via --output flag", () => {
  const dir = makeTempDir({
    "tasks/TASK-GOOD.yaml": "task_id: TASK-GOOD\n",
  });
  const customOutput = path.join(dir, "custom-report.yaml");

  try {
    const result = runPreflight(dir, `--output "${customOutput}"`);
    assert.match(result.stdout, /^ok:/);
    assert(fs.existsSync(customOutput), `Report should exist at ${customOutput}`);
  } finally {
    rm(dir);
  }
});

test("Summary counts: tasks, contracts, consumed, produced", () => {
  const dir = makeTempDir({
    "tasks/TASK-A.yaml": TASK_CONSUMER_STRUCTURED,
    "tasks/TASK-B.yaml": TASK_PRODUCER_STRUCTURED,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
    "contracts/CONTRACT-API-01.yaml": CONTRACT_API,
  });

  try {
    const result = runPreflight(dir);
    assert.equal(result.report.summary.tasks, 2);
    assert.equal(result.report.summary.contracts, 2);
    assert.equal(result.report.summary.consumed_contracts, 1);
    assert.equal(result.report.summary.produced_contracts, 1);
  } finally {
    rm(dir);
  }
});

test("Error message includes unresolved count and breakdown", () => {
  const dir = makeTempDir({
    "tasks/TASK-CONSUMER-MISSING-SYM.yaml": TASK_CONSUMER_MISSING_SYMBOL,
    "tasks/TASK-PRODUCER-01.yaml": TASK_PRODUCER_STRUCTURED,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /err:plan_preflight:\d+ unresolved/);
    assert.match(result.stdout, /\d+ contracts/);
    assert.match(result.stdout, /\d+ symbols/);
    assert.match(result.stdout, /\d+ known gaps/);
  } finally {
    rm(dir);
  }
});

test("Empty manifest (no tasks, no contracts) → ok, all counts zero", () => {
  const dir = makeTempDir({});

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.tasks, 0);
    assert.equal(result.report.summary.contracts, 0);
    assert.equal(result.report.summary.unresolved_contracts, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
  } finally {
    rm(dir);
  }
});

test("known_gap on symbol-level unresolved → suppresses and records reason", () => {
  const TASK_SYMBOL_GAP = `
task_id: TASK-SYMBOL-GAP
known_gap: true
known_gap_reason: Method not yet implemented
contracts_consumed:
  - contract_id: CONTRACT-DB-01
    invokes:
      - JobStore.list
      - JobStore.future_method
`;

  const TASK_PROD = `
task_id: TASK-PROD
contracts_produced:
  - contract_id: CONTRACT-DB-01
    implements:
      - JobStore.list
`;

  const dir = makeTempDir({
    "tasks/TASK-SYMBOL-GAP.yaml": TASK_SYMBOL_GAP,
    "tasks/TASK-PROD.yaml": TASK_PROD,
    "contracts/CONTRACT-DB-01.yaml": CONTRACT_DB,
  });

  try {
    const result = runPreflight(dir);
    assert.match(result.stdout, /^ok:/);
    assert.equal(result.code, 0);
    assert.equal(result.report.summary.unresolved_symbols, 0);
    assert.equal(result.report.summary.known_gaps, 1);
    assert.equal(result.report.known_gaps[0].symbol, "JobStore.future_method");
    assert.equal(result.report.known_gaps[0].reason, "Method not yet implemented");
  } finally {
    rm(dir);
  }
});
