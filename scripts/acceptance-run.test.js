#!/usr/bin/env node
/**
 * acceptance-run.test.js — Tests for acceptance-run.js
 *
 * Tests acceptance harness functionality with various input combinations.
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via:  node scripts/acceptance-run.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const ACCEPTANCE_RUN_SCRIPT = path.resolve(__dirname, "acceptance-run.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-acceptance-run-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run acceptance-run.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runAcceptance(extraArgs = "", env = {}, cwd = path.dirname(ACCEPTANCE_RUN_SCRIPT)) {
  try {
    const mergedEnv = { ...process.env, ...env };
    return execSync(
      `node "${ACCEPTANCE_RUN_SCRIPT}" ${extraArgs}`,
      { encoding: "utf-8", env: mergedEnv, cwd }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a temporary criteria YAML file with test data.
 */
function createCriteriaFile(dir, criteria) {
  const data = { acceptance_criteria: criteria };
  const filePath = path.join(dir, "acceptance-criteria.yaml");
  fs.writeFileSync(filePath, yaml.dump(data), "utf-8");
  return filePath;
}

/**
 * Create a stub directory with canned verdicts for offline testing.
 */
function createStubDir(dir, verdicts) {
  // verdicts is a map of criterion id -> verdict text
  const stubDir = path.join(dir, "stubs");
  fs.mkdirSync(stubDir, { recursive: true });
  for (const [id, verdict] of Object.entries(verdicts)) {
    fs.writeFileSync(path.join(stubDir, `${id}.txt`), verdict, "utf-8");
  }
  return stubDir;
}

// ═══════════════════════════════════════════════════════════════════════════
// BASIC FUNCTIONALITY
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: all-pass with 2 criteria (one observable, one requires-decomposition)", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Users can log in with email and password",
        source: "REQ-USER-001",
        classification: "observable"
      },
      {
        id: "AC-002",
        text: "Admin dashboard enforces role-based access control",
        source: "REQ-ADMIN-001",
        classification: "requires-decomposition",
        subcriteria: [
          "Admin can create and edit user roles",
          "Users cannot access sections for roles they do not have",
          "Role assignments persist across sessions"
        ]
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:curl 200",
      "AC-002": "pass:all sub-criteria pass"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");

    const result = runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    assert.match(result, /^ok:acceptance PASS/, "should output ok:acceptance PASS");
    assert.ok(fs.existsSync(outputFile), "report file should be created");

    const reportContent = fs.readFileSync(outputFile, "utf-8");
    assert.match(reportContent, /\*\*Verdict:\*\* PASS/, "report should show PASS verdict");
    assert.match(reportContent, /AC-001/, "report should include AC-001");
    assert.match(reportContent, /AC-002/, "report should include AC-002");
  } finally {
    rm(dir);
  }
});

test("acceptance-run: one-fail verdict routed correctly", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Users can log in",
        source: "REQ-001",
        classification: "observable"
      },
      {
        id: "AC-002",
        text: "Dashboard shows metrics",
        source: "REQ-002",
        classification: "observable"
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:endpoint returns 200",
      "AC-002": "fail:endpoint returns 500 EvalMetricsReadError not yet initialized"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");

    const result = runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    assert.match(result, /err:acceptance:1 failed/, "should output err:acceptance:1 failed");
    assert.ok(fs.existsSync(outputFile), "report file should still be created");

    const reportContent = fs.readFileSync(outputFile, "utf-8");
    assert.match(reportContent, /\*\*Verdict:\*\* FAIL/, "report should show FAIL verdict");
    assert.match(reportContent, /AC-002/, "report should include failed criterion");
    assert.match(reportContent, /EvalMetricsReadError/, "report should cite the failure reason");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MISSING VERDICT (UNPARSEABLE)
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: missing verdict line (prose-only) counts as fail", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Feature works",
        source: "REQ-001",
        classification: "observable"
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "The feature seems to work, but I can't definitively say yes or no."
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");

    const result = runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    assert.match(result, /err:acceptance:1 failed/, "unparseable verdict should count as fail");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MISSING CRITERIA FILE
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: missing --criteria arg produces err", () => {
  const result = runAcceptance(
    `--app-url http://localhost:3000 --code-dir /tmp/test`
  );

  assert.match(result, /^err:/, "should output err:");
  assert.match(result, /required arguments|--criteria/, "should mention missing args");
});

test("acceptance-run: --criteria file not found produces err", () => {
  const result = runAcceptance(
    `--criteria /nonexistent/path.yaml --app-url http://localhost:3000 --code-dir /tmp/test`
  );

  assert.match(result, /^err:/, "should output err:");
  assert.match(result, /not found/, "should mention file not found");
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT FILE EXISTENCE AND CONTENT
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: report is created at default path if --output not specified", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Basic test",
        source: "REQ-001",
        classification: "observable"
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:works"
    });

    // Run with cwd = temp dir so the default ./ACCEPTANCE-REPORT.md (and its
    // default ./wiki/ evidence dir) land inside the temp dir, not in scripts/.
    const result = runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test`,
      { HPC_JUDGE_STUB_DIR: stubDir },
      dir
    );

    // Default report path is ./ACCEPTANCE-REPORT.md (relative to the run cwd = dir)
    const defaultReportPath = path.join(dir, "ACCEPTANCE-REPORT.md");

    // The test should output ok and the report should exist at the default path.
    assert.match(result, /^ok:acceptance PASS/, "should pass");
    assert.ok(fs.existsSync(defaultReportPath), "default ACCEPTANCE-REPORT.md should exist in run cwd");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PER-CRITERION EVIDENCE FILES
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: per-criterion evidence files written to wiki/acceptance/", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Feature one",
        source: "REQ-001",
        classification: "observable"
      },
      {
        id: "AC-002",
        text: "Feature two",
        source: "REQ-002",
        classification: "observable"
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:evidence here",
      "AC-002": "fail:reason here"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");
    const wikiDir = path.join(dir, "wiki");

    runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}" --wiki-dir "${wikiDir}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    assert.ok(fs.existsSync(path.join(wikiDir, "acceptance", "AC-001.txt")), "AC-001 evidence file should exist");
    assert.ok(fs.existsSync(path.join(wikiDir, "acceptance", "AC-002.txt")), "AC-002 evidence file should exist");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DECOMPOSED CRITERIA HANDLING
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: requires-decomposition criterion is evaluated with subcriteria list", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      {
        id: "AC-001",
        text: "Role-based access control system",
        source: "REQ-RBAC-001",
        classification: "requires-decomposition",
        subcriteria: [
          "Admin can create new roles",
          "Roles cannot be assigned to unauthenticated users",
          "Role permissions persist"
        ]
      }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);

    // We use a stub that captures what the judge would receive
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:all sub-criteria verified"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");

    const result = runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    assert.match(result, /^ok:acceptance PASS/, "decomposed criterion should pass when all subcriteria pass");
    const report = fs.readFileSync(outputFile, "utf-8");
    assert.match(report, /requires-decomposition/, "report should mention the classification");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY COUNTS IN REPORT
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: report summary counts match actual results", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      { id: "AC-001", text: "T1", source: "R1", classification: "observable" },
      { id: "AC-002", text: "T2", source: "R2", classification: "observable" },
      { id: "AC-003", text: "T3", source: "R3", classification: "observable" }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:p1",
      "AC-002": "pass:p2",
      "AC-003": "fail:f3"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");

    runAcceptance(
      `--criteria "${criteriaFile}" --app-url http://localhost:3000 --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    const report = fs.readFileSync(outputFile, "utf-8");
    assert.match(report, /Criteria evaluated: 3/, "should report 3 criteria");
    assert.match(report, /Passed: 2/, "should report 2 passed");
    assert.match(report, /Failed: 1/, "should report 1 failed");
  } finally {
    rm(dir);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT TIMESTAMP AND APP URL
// ═══════════════════════════════════════════════════════════════════════════

test("acceptance-run: report includes ISO timestamp and app URL", () => {
  const dir = makeTempDir();
  try {
    const criteria = [
      { id: "AC-001", text: "Test", source: "R1", classification: "observable" }
    ];
    const criteriaFile = createCriteriaFile(dir, criteria);
    const stubDir = createStubDir(dir, {
      "AC-001": "pass:ok"
    });
    const outputFile = path.join(dir, "ACCEPTANCE-REPORT.md");
    const appUrl = "http://localhost:9999";

    runAcceptance(
      `--criteria "${criteriaFile}" --app-url "${appUrl}" --code-dir /tmp/test --output "${outputFile}"`,
      { HPC_JUDGE_STUB_DIR: stubDir }
    );

    const report = fs.readFileSync(outputFile, "utf-8");
    assert.match(report, /\*\*Tested at:\*\*.*\d{4}-\d{2}-\d{2}/, "should include ISO timestamp");
    assert.match(report, new RegExp(`\\*\\*Application URL:\\*\\*.*${appUrl}`), "should include app URL");
  } finally {
    rm(dir);
  }
});
