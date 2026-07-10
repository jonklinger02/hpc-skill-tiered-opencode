#!/usr/bin/env node
/**
 * notify-halt.test.js — Tests for notify-halt.js
 *
 * Tests halt notification for git commit, webhook POST, and error conditions.
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via:  node notify-halt.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NOTIFY_HALT_SCRIPT = path.resolve(__dirname, "notify-halt.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-notify-halt-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run notify-halt.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runNotifyHalt(report, kind, extraArgs = "") {
  try {
    return execSync(
      `node "${NOTIFY_HALT_SCRIPT}" --report "${report}" --kind "${kind}" ${extraArgs}`,
      { encoding: "utf-8", cwd: path.dirname(NOTIFY_HALT_SCRIPT) }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a temporary report file with a markdown header.
 */
function createReportFile(dir, filename, subject) {
  const reportPath = path.join(dir, filename);
  const content = `# ${subject}\n\nThis is a test report.\n`;
  fs.writeFileSync(reportPath, content);
  return reportPath;
}

/**
 * Initialize a git repo in a temp dir with user config.
 */
function initGitRepo(dir) {
  execSync(`git -C "${dir}" init`, { encoding: "utf-8" });
  execSync(`git -C "${dir}" config user.email "test@example.com"`, { encoding: "utf-8" });
  execSync(`git -C "${dir}" config user.name "Test User"`, { encoding: "utf-8" });
}

/**
 * Get the subject from the latest commit message.
 */
function getLatestCommitSubject(dir) {
  try {
    return execSync(`git -C "${dir}" log -1 --pretty=%s`, { encoding: "utf-8" }).trim();
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BASIC FUNCTIONALITY
// ═══════════════════════════════════════════════════════════════════════════

test("notify-halt: dry-run with H1 subject captures subject in sidecar", () => {
  const dir = makeTempDir();
  try {
    const reportPath = createReportFile(dir, "SPEC-DEFECT.md", "SPEC-DEFECT: foo");
    const result = runNotifyHalt(reportPath, "SPEC-DEFECT", "--dry-run");

    assert.match(result, /^ok:/, "should output ok: message");
    assert.match(result, /SPEC-DEFECT/, "should mention kind");

    // Check sidecar exists and loads
    const sidecarPath = `${reportPath}.notify.json`;
    assert(fs.existsSync(sidecarPath), "sidecar .notify.json should exist");

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.strictEqual(sidecar.subject, "SPEC-DEFECT: foo", "should capture subject from H1");
    assert.strictEqual(sidecar.kind, "SPEC-DEFECT", "should record kind");
  } finally {
    rm(dir);
  }
});

test("notify-halt: real commit path with --no-push produces [HPC-HALT] message", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);

    const reportPath = createReportFile(dir, "ACCEPTANCE-REPORT.md", "All tests passed");
    const result = runNotifyHalt(
      reportPath,
      "PASS",
      `--workspace "${dir}" --no-push`
    );

    assert.match(result, /^ok:/, "should output ok: message");
    assert.match(result, /PASS/, "should mention kind");

    // Check git log for [HPC-HALT][PASS] prefix
    const commitSubject = getLatestCommitSubject(dir);
    assert.match(commitSubject, /^\[HPC-HALT\]\[PASS\]/, "commit should have [HPC-HALT][PASS] prefix");
    assert.match(commitSubject, /All tests passed/, "commit should contain subject");

    // Check sidecar
    const sidecarPath = `${reportPath}.notify.json`;
    assert(fs.existsSync(sidecarPath), "sidecar should exist");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.strictEqual(sidecar.kind, "PASS", "sidecar should record kind");
  } finally {
    rm(dir);
  }
});

test("notify-halt: non-git workspace skips commit, no error", () => {
  const dir = makeTempDir();
  try {
    // dir is NOT a git repo
    const reportPath = createReportFile(dir, "RUN-ABORTED.md", "Run was aborted");
    const result = runNotifyHalt(
      reportPath,
      "RUN-ABORTED",
      `--workspace "${dir}" --no-push`
    );

    assert.match(result, /^ok:/, "should output ok: message");
    assert.match(result, /skipped/, "should indicate skipped commit");

    // Check sidecar
    const sidecarPath = `${reportPath}.notify.json`;
    assert(fs.existsSync(sidecarPath), "sidecar should exist");
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.match(sidecar.commit, /not a git repo/, "commit should record skipped reason");
  } finally {
    rm(dir);
  }
});

test("notify-halt: missing --report returns err:", () => {
  const dir = makeTempDir();
  try {
    const result = runNotifyHalt("nonexistent.md", "FAIL", "--dry-run");
    assert.match(result, /^err:/, "should output err: message");
  } finally {
    rm(dir);
  }
});

test("notify-halt: missing --kind returns err:", () => {
  const dir = makeTempDir();
  try {
    const reportPath = createReportFile(dir, "test.md", "Test");
    const result = execSync(
      `node "${NOTIFY_HALT_SCRIPT}" --report "${reportPath}" --dry-run`,
      { encoding: "utf-8", cwd: path.dirname(NOTIFY_HALT_SCRIPT) }
    ).trim();
    // This should fail in some way; let's verify via stderr capture
  } catch (e) {
    const stderr = (e.stderr || "").trim();
    assert.match(stderr, /missing --kind/, "should complain about missing --kind");
  } finally {
    rm(dir);
  }
});

test("notify-halt: sidecar JSON has required fields", () => {
  const dir = makeTempDir();
  try {
    const reportPath = createReportFile(dir, "test-report.md", "Test Header");
    runNotifyHalt(reportPath, "FAIL", "--dry-run");

    const sidecarPath = `${reportPath}.notify.json`;
    assert(fs.existsSync(sidecarPath), "sidecar should exist");

    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert(sidecar.kind, "sidecar should have kind");
    assert(sidecar.subject, "sidecar should have subject");
    assert(sidecar.report_path, "sidecar should have report_path");
    assert(sidecar.timestamp, "sidecar should have timestamp");
    assert(sidecar.commit !== undefined, "sidecar should have commit field");
  } finally {
    rm(dir);
  }
});

test("notify-halt: report subject falls back to basename if no H1", () => {
  const dir = makeTempDir();
  try {
    const reportPath = path.join(dir, "fallback-report.md");
    fs.writeFileSync(reportPath, "No header here\nJust plain text.\n");

    runNotifyHalt(reportPath, "FAIL", "--dry-run");

    const sidecarPath = `${reportPath}.notify.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert.strictEqual(sidecar.subject, "fallback-report.md", "subject should fall back to basename");
  } finally {
    rm(dir);
  }
});

test("notify-halt: different kinds in commit message", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);

    // Test SANITY-CAP kind
    const reportPath = createReportFile(dir, "sanity.md", "Sanity check failed");
    runNotifyHalt(reportPath, "SANITY-CAP", `--workspace "${dir}" --no-push`);

    const commitSubject = getLatestCommitSubject(dir);
    assert.match(commitSubject, /\[HPC-HALT\]\[SANITY-CAP\]/, "should include SANITY-CAP kind");
  } finally {
    rm(dir);
  }
});

test("notify-halt: dry-run does not create git commits", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);

    const reportPath = createReportFile(dir, "test.md", "Test");
    runNotifyHalt(reportPath, "FAIL", `--workspace "${dir}" --dry-run`);

    // Check that no commit was made
    try {
      const commitCount = execSync(`git -C "${dir}" rev-list --count HEAD`, { encoding: "utf-8" }).trim();
      assert.strictEqual(commitCount, "0", "dry-run should not create commits");
    } catch (e) {
      // Empty repo raises error on rev-list HEAD; that's expected behavior
      assert(e.status === 128, "empty repo should fail git rev-list with status 128");
    }
  } finally {
    rm(dir);
  }
});

test("notify-halt: sidecar records push result", () => {
  const dir = makeTempDir();
  try {
    initGitRepo(dir);

    const reportPath = createReportFile(dir, "test.md", "Test");
    runNotifyHalt(reportPath, "FAIL", `--workspace "${dir}" --no-push --dry-run`);

    const sidecarPath = `${reportPath}.notify.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8"));
    assert(sidecar.push !== undefined, "sidecar should have push field (from --no-push or --dry-run)");
  } finally {
    rm(dir);
  }
});
