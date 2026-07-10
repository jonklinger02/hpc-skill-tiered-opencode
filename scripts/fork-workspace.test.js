#!/usr/bin/env node
/**
 * fork-workspace.test.js — Tests for fork-workspace.js
 *
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via: node fork-workspace.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const FORK_WORKSPACE_SCRIPT = path.resolve(__dirname, "fork-workspace.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-fork-workspace-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run fork-workspace.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runForkWorkspace(args = "") {
  try {
    return execSync(
      `node "${FORK_WORKSPACE_SCRIPT}" ${args}`,
      { encoding: "utf-8", cwd: path.dirname(FORK_WORKSPACE_SCRIPT), stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a fake workspace with manifest/, wiki/, node_modules/, execute-logs/
 */
function createFakeWorkspace(parentDir, name = "test-workspace") {
  const workspaceDir = path.join(parentDir, name);
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Create manifest/manifest.yaml
  const manifestDir = path.join(workspaceDir, "manifest");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "manifest.yaml"),
    `manifest_id: "test-manifest-123"\nversion: "1.0.0"\nstatus: APPROVED\n`
  );

  // Create wiki/.gitkeep
  const wikiDir = path.join(workspaceDir, "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });
  fs.writeFileSync(path.join(wikiDir, ".gitkeep"), "");

  // Create node_modules/junk.js (to be excluded)
  const nodeModulesDir = path.join(workspaceDir, "node_modules");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.writeFileSync(path.join(nodeModulesDir, "junk.js"), "// junk file");

  // Create execute-logs/run.log (to be excluded)
  const logsDir = path.join(workspaceDir, "execute-logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "run.log"), "2024-01-01: execution started");

  // Create some other files that should be included
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Test Workspace");
  const storeDir = path.join(workspaceDir, "store");
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, "data.json"), '{"key": "value"}');

  return workspaceDir;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("fork-workspace: snapshot creates iteration-1", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Run snapshot
    const result = runForkWorkspace(`--workspace "${workspaceDir}"`);
    assert.match(result, /^ok:/, "stdout should start with 'ok:'");
    assert.match(result, /forked=/, "output should contain 'forked='");
    assert.match(result, /iteration=1/, "output should contain 'iteration=1'");

    // Verify the destination directory exists
    const destDir = path.join(tempDir, "test-workspace.tier3-iteration-1");
    assert(fs.existsSync(destDir), "tier3-iteration-1 directory should exist");

    // Verify manifest was copied
    const manifestFile = path.join(destDir, "manifest", "manifest.yaml");
    assert(fs.existsSync(manifestFile), "manifest/manifest.yaml should exist in snapshot");

    // Verify wiki was copied (but not .current link yet)
    const wikiFile = path.join(destDir, "wiki", ".gitkeep");
    assert(fs.existsSync(wikiFile), "wiki/.gitkeep should exist in snapshot");

    // Verify excluded dirs are NOT present
    const nodeModulesInDest = path.join(destDir, "node_modules");
    assert(!fs.existsSync(nodeModulesInDest), "node_modules should NOT be in snapshot");

    const logsInDest = path.join(destDir, "execute-logs");
    assert(!fs.existsSync(logsInDest), "execute-logs should NOT be in snapshot");

    // Verify included dirs are present
    const readmeInDest = path.join(destDir, "README.md");
    assert(fs.existsSync(readmeInDest), "README.md should be in snapshot");

    const storeDir = path.join(destDir, "store", "data.json");
    assert(fs.existsSync(storeDir), "store/data.json should be in snapshot");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: maintains .current symlink (or file)", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Run snapshot
    runForkWorkspace(`--workspace "${workspaceDir}"`);

    // Check for .current symlink or file
    const currentLink = path.join(tempDir, "test-workspace.current");
    assert(fs.existsSync(currentLink), ".current symlink/file should exist");

    // Verify it points to iteration-1
    const stat = fs.lstatSync(currentLink);
    let target;
    if (stat.isSymbolicLink()) {
      target = fs.readlinkSync(currentLink);
    } else if (stat.isFile()) {
      target = fs.readFileSync(currentLink, "utf-8").trim();
    }
    assert(target, "current should have a target");
    assert(target.includes("tier3-iteration-1"), "current should point to iteration-1");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: creates iteration-2 on second snapshot", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // First snapshot
    const result1 = runForkWorkspace(`--workspace "${workspaceDir}"`);
    assert.match(result1, /iteration=1/, "first snapshot should be iteration=1");

    // Second snapshot
    const result2 = runForkWorkspace(`--workspace "${workspaceDir}"`);
    assert.match(result2, /iteration=2/, "second snapshot should be iteration=2");

    // Verify both exist
    const dest1 = path.join(tempDir, "test-workspace.tier3-iteration-1");
    const dest2 = path.join(tempDir, "test-workspace.tier3-iteration-2");
    assert(fs.existsSync(dest1), "iteration-1 should still exist");
    assert(fs.existsSync(dest2), "iteration-2 should exist");

    // Verify .current now points to iteration-2
    const currentLink = path.join(tempDir, "test-workspace.current");
    const stat = fs.lstatSync(currentLink);
    let target;
    if (stat.isSymbolicLink()) {
      target = fs.readlinkSync(currentLink);
    } else if (stat.isFile()) {
      target = fs.readFileSync(currentLink, "utf-8").trim();
    }
    assert(target.includes("tier3-iteration-2"), "current should now point to iteration-2");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: --list shows all forks and current target", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Create two iterations
    runForkWorkspace(`--workspace "${workspaceDir}"`);
    runForkWorkspace(`--workspace "${workspaceDir}"`);

    // Run --list
    const result = runForkWorkspace(`--workspace "${workspaceDir}" --list`);
    assert.match(result, /^ok:/, "list output should start with 'ok:'");
    assert.match(result, /forks=\[/, "output should contain 'forks=['");
    assert.match(result, /tier3-iteration-1/, "should list iteration-1");
    assert.match(result, /tier3-iteration-2/, "should list iteration-2");
    assert.match(result, /current=.+tier3-iteration-2/, "current should reference iteration-2");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: --list shows 'current=none' when no forks exist", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Run --list without any snapshots
    const result = runForkWorkspace(`--workspace "${workspaceDir}" --list`);
    assert.match(result, /^ok:/, "list output should start with 'ok:'");
    assert.match(result, /forks=\[\]/, "should show empty fork list");
    assert.match(result, /current=none/, "current should be 'none'");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: missing --workspace returns err", () => {
  const result = runForkWorkspace("");
  assert.match(result, /^err:/, "output should start with 'err:'");
  assert.match(result, /--workspace required/, "error should mention --workspace");
});

test("fork-workspace: invalid workspace path returns err", () => {
  const result = runForkWorkspace(`--workspace "/nonexistent/path/to/workspace"`);
  assert.match(result, /^err:/, "output should start with 'err:'");
  assert.match(result, /valid directory/, "error should mention valid directory");
});

test("fork-workspace: --reason is recorded in audit", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Run snapshot with custom reason
    const customReason = "manual recovery at 2024-01-15 10:30 UTC";
    runForkWorkspace(`--workspace "${workspaceDir}" --reason "${customReason}"`);

    // Check audit file
    const auditFile = path.join(workspaceDir, "wiki", "autonomous-decisions.yaml");
    assert(fs.existsSync(auditFile), "autonomous-decisions.yaml should exist");

    const auditContent = fs.readFileSync(auditFile, "utf-8");
    assert(auditContent.includes(customReason), "audit should contain custom reason");
    assert(auditContent.includes("M5_TIER_3"), "audit should contain tier label");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: default reason is 'tier3-escalation'", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    // Run snapshot without --reason
    runForkWorkspace(`--workspace "${workspaceDir}"`);

    // Check audit file
    const auditFile = path.join(workspaceDir, "wiki", "autonomous-decisions.yaml");
    assert(fs.existsSync(auditFile), "autonomous-decisions.yaml should exist");

    const auditContent = fs.readFileSync(auditFile, "utf-8");
    assert(auditContent.includes("tier3-escalation"), "audit should contain default reason");
  } finally {
    rm(tempDir);
  }
});

test("fork-workspace: snapshot output line format", () => {
  const tempDir = makeTempDir();
  try {
    const workspaceDir = createFakeWorkspace(tempDir);

    const result = runForkWorkspace(`--workspace "${workspaceDir}"`);

    // Verify format: ok:forked=<dest> iteration=<N> current=<path>
    const match = result.match(/^ok:forked=(.+) iteration=(\d+) current=(.+)$/);
    assert(match, "output should match expected format");
    assert.strictEqual(match[2], "1", "iteration should be 1");
    assert(match[1].includes("tier3-iteration-1"), "forked path should contain iteration-1");
    assert(match[3].includes(".current"), "current should be .current path");
  } finally {
    rm(tempDir);
  }
});
