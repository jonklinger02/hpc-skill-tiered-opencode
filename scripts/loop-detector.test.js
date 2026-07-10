#!/usr/bin/env node
// Tests for loop-detector.js — detect non-converging recovery loops
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node loop-detector.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const LOOP_DETECTOR_SCRIPT = path.resolve(__dirname, "loop-detector.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-loop-detector-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run loop-detector.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runLoopDetector(stateFile, reportFile) {
  try {
    const cmd =
      reportFile === undefined
        ? `node "${LOOP_DETECTOR_SCRIPT}" --state "${stateFile}"`
        : `node "${LOOP_DETECTOR_SCRIPT}" --state "${stateFile}" --report "${reportFile}"`;
    return execSync(cmd, {
      encoding: "utf-8",
      cwd: path.dirname(LOOP_DETECTOR_SCRIPT),
    }).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Load and parse a report YAML file
 */
function loadReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  const content = fs.readFileSync(reportPath, "utf-8");
  return yaml.load(content);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("zero iterations → verdict:continue", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(stateFile, "iterations: []");

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:continue"),
      `Expected verdict:continue, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("one iteration → verdict:continue", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-001",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:continue"),
      `Expected verdict:continue, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("two iterations, same slice, same task_signature_hash → verdict:escalate (signature-stable)", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-001",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-002",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:escalate:signature-stable"),
      `Expected verdict:escalate:signature-stable, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("three iterations, same slice, DIFFERENT task_signature_hashes, all unresolved → verdict:escalate (slice-stable)", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-001",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-002",
            task_signature_hash: "TS-y",
            outcome: "unresolved",
          },
          {
            iteration: 3,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-003",
            task_signature_hash: "TS-z",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:escalate:slice-stable"),
      `Expected verdict:escalate:slice-stable, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("three iterations where iter1.manifest_hash == iter3.manifest_hash (different slices) → verdict:halt (manifest-cycle)", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-CYCLE",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashB",
            manifest_hash: "MH-002",
            task_signature_hash: "TS-y",
            outcome: "unresolved",
          },
          {
            iteration: 3,
            tier: 2,
            slice: "S-hashC",
            manifest_hash: "MH-CYCLE",
            task_signature_hash: "TS-z",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:halt:manifest-cycle"),
      `Expected verdict:halt:manifest-cycle, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("three iterations with the SAME manifest_hash (no amendment yet) → no manifest-cycle halt", () => {
  // Regression: the escalation ladder records iterations BEFORE any manifest
  // amendment (deliberate-fork.js 'escalated_no_amendment'/'escalated_diffguard'),
  // producing identical hashes — that is not an A→B→A oscillation.
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-SAME",
            task_signature_hash: "TS-x",
            outcome: "escalated_no_amendment",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashB",
            manifest_hash: "MH-SAME",
            task_signature_hash: "TS-y",
            outcome: "escalated_diffguard",
          },
          {
            iteration: 3,
            tier: 2,
            slice: "S-hashC",
            manifest_hash: "MH-SAME",
            task_signature_hash: "TS-z",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      !output.startsWith("verdict:halt:manifest-cycle"),
      `Expected no manifest-cycle halt for unchanged hashes, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("three iterations with ABSENT manifest_hashes → no manifest-cycle halt", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashB",
            task_signature_hash: "TS-y",
            outcome: "unresolved",
          },
          {
            iteration: 3,
            tier: 2,
            slice: "S-hashC",
            task_signature_hash: "TS-z",
            outcome: "unresolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      !output.startsWith("verdict:halt:manifest-cycle"),
      `Expected no manifest-cycle halt for absent hashes, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("healthy progression (different slices, different hashes, last outcome resolved) → verdict:continue", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-001",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashB",
            manifest_hash: "MH-002",
            task_signature_hash: "TS-y",
            outcome: "unresolved",
          },
          {
            iteration: 3,
            tier: 2,
            slice: "S-hashC",
            manifest_hash: "MH-003",
            task_signature_hash: "TS-z",
            outcome: "resolved",
          },
        ],
      })
    );

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:continue"),
      `Expected verdict:continue, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("report YAML has verdict field and loads successfully", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    const reportFile = path.join(tempDir, "loop-detector-report.yaml");

    fs.writeFileSync(
      stateFile,
      yaml.dump({
        iterations: [
          {
            iteration: 1,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-001",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
          {
            iteration: 2,
            tier: 2,
            slice: "S-hashA",
            manifest_hash: "MH-002",
            task_signature_hash: "TS-x",
            outcome: "unresolved",
          },
        ],
      })
    );

    runLoopDetector(stateFile, reportFile);

    const report = loadReport(reportFile);
    assert.ok(report !== null, "Report file should exist");
    assert.ok("verdict" in report, "Report should have verdict field");
    assert.ok("fired_detectors" in report, "Report should have fired_detectors field");
    assert.ok("iteration_count" in report, "Report should have iteration_count field");
    assert.strictEqual(report.verdict, "escalate", "Verdict should be escalate");
    assert.deepStrictEqual(
      report.fired_detectors,
      ["signature-stable"],
      "Should have fired signature-stable"
    );
  } finally {
    rm(tempDir);
  }
});

test("missing state file → verdict:continue with no iterations yet", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "nonexistent.yaml");

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:continue"),
      `Expected verdict:continue, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});

test("bare top-level list format (not {iterations: [...]}) → parsed correctly", () => {
  const tempDir = makeTempDir();
  try {
    const stateFile = path.join(tempDir, "recovery-state.yaml");
    // Write as a bare list (not wrapped in {iterations: ...})
    const content = yaml.dump([
      {
        iteration: 1,
        tier: 2,
        slice: "S-hashA",
        manifest_hash: "MH-001",
        task_signature_hash: "TS-x",
        outcome: "unresolved",
      },
      {
        iteration: 2,
        tier: 2,
        slice: "S-hashA",
        manifest_hash: "MH-002",
        task_signature_hash: "TS-x",
        outcome: "unresolved",
      },
    ]);
    fs.writeFileSync(stateFile, content);

    const output = runLoopDetector(stateFile);
    assert.ok(
      output.startsWith("verdict:escalate:signature-stable"),
      `Expected verdict:escalate:signature-stable for bare list, got: ${output}`
    );
  } finally {
    rm(tempDir);
  }
});
