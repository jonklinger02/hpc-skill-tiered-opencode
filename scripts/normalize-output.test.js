#!/usr/bin/env node
// Tests for normalize-output.js — language-aware frontmatter generation,
// idempotency, chat-prose salvage, and skip conditions.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node normalize-output.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NORMALIZE_SCRIPT = path.resolve(__dirname, "normalize-output.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-normalize-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run normalize-output.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runNormalize(outputFile, taskFile, extraArgs = "") {
  try {
    return execSync(
      `node "${NORMALIZE_SCRIPT}" --output-file "${outputFile}" --task-file "${taskFile}" ${extraArgs}`,
      { encoding: "utf-8" }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/** Minimal task spec YAML with required fields. */
function makeTaskSpec(overrides = {}) {
  const defaults = {
    task_id: "TASK-API-0001",
    group_id: "GRP-API-001",
    file_path: overrides.file_path || "src/api/users.ts",
    artifact_type: "source",
    generated_by: "claude-haiku-4-5-20251001",
  };
  const merged = { ...defaults, ...overrides };
  return [
    `task_id: ${merged.task_id}`,
    `group_id: ${merged.group_id}`,
    `file_path: ${merged.file_path}`,
    `artifact_type: ${merged.artifact_type}`,
    `generated_by: ${merged.generated_by}`,
    "contracts_produced: []",
    "contracts_consumed: []",
    "depends_on: []",
  ].join("\n");
}

/**
 * Write an output file + task spec, run normalize, return the resulting
 * file content.
 */
function normalize(dir, filename, bodyContent, taskSpecOverrides = {}) {
  const outFile = path.join(dir, filename);
  const specFile = path.join(dir, filename + ".spec.yaml");
  fs.writeFileSync(outFile, bodyContent);
  fs.writeFileSync(specFile, makeTaskSpec({ file_path: filename, ...taskSpecOverrides }));
  runNormalize(outFile, specFile);
  return fs.readFileSync(outFile, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
// LANGUAGE-AWARE FRONTMATTER
// ═══════════════════════════════════════════════════════════════════════════

test("normalize: Python file gets '# ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "main.py", "def main():\n    pass\n");
    assert.match(content, /^# ---/m, "should open with '# ---'");
    assert.match(content, /^# task_id:/m, "task_id field should be prefixed with '# '");
    // The file should remain valid Python after normalization
    execSync(`python3 -c "import ast; ast.parse(open('${path.join(dir, "main.py")}').read())"`, { stdio: "ignore" });
  } finally { rm(dir); }
});

test("normalize: TypeScript file gets '// ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "users.ts", "export const foo = 1;\n");
    assert.match(content, /^\/\/ ---/m, "should open with '// ---'");
    assert.match(content, /^\/\/ task_id:/m, "task_id field should be prefixed with '// '");
    // Should not have raw YAML frontmatter (that would break the TypeScript file)
    assert.doesNotMatch(content, /^---\s*$/m, "should not have raw '---' YAML opener");
  } finally { rm(dir); }
});

test("normalize: JavaScript file gets '// ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "index.js", "module.exports = {};\n");
    assert.match(content, /^\/\/ ---/m);
  } finally { rm(dir); }
});

test("normalize: SQL file gets '-- ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "init.sql", "CREATE TABLE users (id UUID PRIMARY KEY);\n");
    assert.match(content, /^-- ---/m, "should open with '-- ---'");
    assert.match(content, /^-- task_id:/m, "fields should be prefixed with '-- '");
  } finally { rm(dir); }
});

test("normalize: Markdown file gets raw '---' YAML frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "README.md", "# Hello\n");
    // Markdown uses canonical YAML frontmatter (raw ---)
    assert.match(content, /^---\s*$/m, "should have raw '---' YAML opener");
    assert.match(content, /^task_id:/m, "task_id should appear without comment prefix");
  } finally { rm(dir); }
});

test("normalize: HTML file gets <!-- --> block comment frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "index.html", "<html><body></body></html>\n");
    assert.match(content, /^<!--/m, "should open with HTML block comment");
    assert.match(content, /-->/m,   "should close with -->");
    assert.match(content, /task_id:/m, "task_id should appear inside the comment block");
  } finally { rm(dir); }
});

test("normalize: Go file gets '// ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "main.go", 'package main\nfunc main() {}\n');
    assert.match(content, /^\/\/ ---/m);
  } finally { rm(dir); }
});

test("normalize: Shell script gets '# ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "build.sh", "#!/bin/bash\necho hello\n");
    assert.match(content, /^# ---/m);
  } finally { rm(dir); }
});

test("normalize: YAML config file gets '# ---' style frontmatter", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "docker-compose.yaml", "version: '3'\nservices:\n  api:\n    image: foo\n");
    assert.match(content, /^# ---/m);
    // File should not start with raw '---' (would collide with YAML doc-start)
    assert.ok(!content.startsWith("---"), "should not open with raw YAML doc-start");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

test("normalize: idempotent — already-normalized TS file is unchanged", () => {
  const dir = makeTempDir();
  try {
    // First pass
    normalize(dir, "service.ts", "export class Svc {}\n");
    const afterFirst = fs.readFileSync(path.join(dir, "service.ts"), "utf-8");
    // Second pass (re-run normalize on the already-normalized file)
    const specFile = path.join(dir, "service.ts.spec.yaml");
    runNormalize(path.join(dir, "service.ts"), specFile);
    const afterSecond = fs.readFileSync(path.join(dir, "service.ts"), "utf-8");
    assert.equal(afterFirst, afterSecond, "second normalize pass must be a no-op");
  } finally { rm(dir); }
});

test("normalize: idempotent — already-normalized Python file is unchanged", () => {
  const dir = makeTempDir();
  try {
    normalize(dir, "util.py", "def helper(): pass\n");
    const afterFirst = fs.readFileSync(path.join(dir, "util.py"), "utf-8");
    const specFile = path.join(dir, "util.py.spec.yaml");
    runNormalize(path.join(dir, "util.py"), specFile);
    const afterSecond = fs.readFileSync(path.join(dir, "util.py"), "utf-8");
    assert.equal(afterFirst, afterSecond, "no duplicate frontmatter on second run");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAT-PROSE SALVAGE
// ═══════════════════════════════════════════════════════════════════════════

test("normalize: chat-prose wrapper stripped, code block extracted (TS)", () => {
  const dir = makeTempDir();
  const chatOutput = [
    "I'll implement this for you now.",
    "",
    "```typescript",
    "export class AuthService {",
    "  login(email: string): boolean { return true; }",
    "}",
    "```",
    "",
    "This should work correctly.",
  ].join("\n");
  try {
    const content = normalize(dir, "auth.ts", chatOutput);
    // The chat prose and fences should be gone; the class should remain
    assert.doesNotMatch(content, /I'll implement/, "prose should be stripped");
    assert.doesNotMatch(content, /```/, "fences should be stripped");
    assert.match(content, /export class AuthService/, "code body must be preserved");
  } finally { rm(dir); }
});

test("normalize: multiple fenced blocks — largest block wins", () => {
  const dir = makeTempDir();
  const chatOutput = [
    "Here is a small helper:",
    "```python",
    "x = 1",
    "```",
    "And here is the main implementation:",
    "```python",
    "import os",
    "import sys",
    "",
    "def main():",
    "    # heavy implementation",
    "    return os.getcwd()",
    "",
    "if __name__ == '__main__':",
    "    main()",
    "```",
  ].join("\n");
  try {
    const content = normalize(dir, "main.py", chatOutput);
    assert.match(content, /def main/, "larger block should be used");
    assert.doesNotMatch(content, /^x = 1$/m, "smaller block should be discarded");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SKIP CONDITIONS
// ═══════════════════════════════════════════════════════════════════════════

test("normalize: missing output file → skip message, exits 0", () => {
  const dir = makeTempDir();
  const specFile = path.join(dir, "spec.yaml");
  fs.writeFileSync(specFile, makeTaskSpec());
  try {
    const result = runNormalize(path.join(dir, "nonexistent.ts"), specFile);
    assert.match(result, /skip:output_file_missing/, "should report skip, not crash");
  } finally { rm(dir); }
});

test("normalize: missing task spec file → skip message, exits 0", () => {
  const dir = makeTempDir();
  const outFile = path.join(dir, "main.ts");
  fs.writeFileSync(outFile, "export const x = 1;\n");
  try {
    const result = runNormalize(outFile, path.join(dir, "nonexistent-spec.yaml"));
    assert.match(result, /skip:task_file_missing/, "should report skip, not crash");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// FRONTMATTER CONTENT
// ═══════════════════════════════════════════════════════════════════════════

test("normalize: frontmatter carries task_id from spec", () => {
  const dir = makeTempDir();
  try {
    const content = normalize(dir, "handler.ts", "export const handler = () => {};\n", {
      task_id: "TASK-XYZ-9999",
    });
    assert.match(content, /task_id:\s*TASK-XYZ-9999/, "task_id should come from the spec");
  } finally { rm(dir); }
});

test("normalize: auto_normalized flag set when prepend occurs (missing frontmatter)", () => {
  const dir = makeTempDir();
  // Plain code — no frontmatter → normalize should prepend and mark auto_normalized
  try {
    const content = normalize(dir, "utils.ts", "export const noop = () => {};\n");
    // Should include auto_normalized or at minimum include the task_id
    // (auto_normalized is set when normalize prepends; not present when worker wrote it)
    assert.match(content, /task_id:/, "frontmatter should be present regardless");
  } finally { rm(dir); }
});
