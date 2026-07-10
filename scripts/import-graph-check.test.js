#!/usr/bin/env node
/**
 * Tests for import-graph-check.js
 *
 * Run via: node scripts/import-graph-check.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const SCRIPT = path.resolve(__dirname, "import-graph-check.js");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a temp directory with output-dir and manifest-dir structure.
 * Returns { outputDir, manifestDir, cleanup }
 */
function setupFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hpc-import-test-"));
  const outputDir = path.join(base, "output");
  const manifestDir = path.join(base, "manifest");

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(manifestDir, "tasks"), { recursive: true });

  return {
    outputDir,
    manifestDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Write a file in outputDir (relative path).
 */
function writeOutput(outputDir, relPath, content) {
  const fullPath = path.join(outputDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

/**
 * Write a task file in manifestDir/tasks.
 */
function writeTask(manifestDir, taskName, filePath) {
  const taskContent = yaml.dump({
    task_id: taskName,
    group_id: "TEST-GRP-001",
    file_path: filePath,
    contracts_produced: [],
    contracts_consumed: [],
    depends_on: [],
  });
  const taskPath = path.join(manifestDir, "tasks", `${taskName}.yaml`);
  fs.writeFileSync(taskPath, taskContent);
}

/**
 * Write manifest.yaml with optional tech_stack.
 */
function writeManifest(manifestDir, techStack) {
  const manifest = {
    name: "Test Project",
    tech_stack: techStack || [],
  };
  const manifestPath = path.join(manifestDir, "manifest.yaml");
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
}

/**
 * Run import-graph-check and return stdout (trimmed).
 */
function runCheck(outputDir, manifestDir, extra = "") {
  try {
    return execSync(
      `node "${SCRIPT}" --output-dir "${outputDir}" --manifest-dir "${manifestDir}" ${extra}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Load and parse the generated report.yaml.
 */
function loadReport(outputDir, manifestDir, reportPath = null) {
  let rPath = reportPath;
  if (!rPath) {
    const parent = path.dirname(outputDir);
    rPath = path.join(parent, "wiki", "import-graph-report.yaml");
  }
  if (!fs.existsSync(rPath)) return null;
  return yaml.load(fs.readFileSync(rPath, "utf-8"));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

test("TS: local import resolves when file exists", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./b";\n');
    writeOutput(outputDir, "src/b.ts", "export const x = 1;\n");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);
    assert.match(result, /clean/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
    assert.equal(report.summary.resolved, 1);
  } finally { cleanup(); }
});

test("TS: local import fails when file missing", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./missing";\n');
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /err:/);
    assert.match(result, /orphan/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 1);
    assert.equal(report.orphans[0].specifier, "./missing");
  } finally { cleanup(); }
});

test("TS: external import (react) is not an orphan", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import React from "react";\n');
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
    assert.equal(report.summary.external_imports, 1);
  } finally { cleanup(); }
});

test("TS: relative import ../ resolves across directories", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/pages/home.ts", 'import { util } from "../utils";\n');
    writeOutput(outputDir, "src/utils.ts", "export function util() {}\n");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Python: local import resolves when file exists", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "pkg/a.py", "from pkg.b import x\n");
    writeOutput(outputDir, "pkg/b.py", "x = 1\n");
    writeManifest(manifestDir, ["python"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Python: relative import with dot resolves", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "pkg/sub/a.py", "from .b import x\n");
    writeOutput(outputDir, "pkg/sub/b.py", "x = 1\n");
    writeManifest(manifestDir, ["python"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Python: unresolved local import is an orphan", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "pkg/a.py", "from pkg.missing import x\n");
    writeManifest(manifestDir, ["python"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /err:/);
    assert.match(result, /orphan/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 1);
  } finally { cleanup(); }
});

test("Rust files are recorded under unsupported_stacks", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/main.rs", "fn main() {}\n");
    writeOutput(outputDir, "src/lib.ts", 'import { x } from "./utils";\n');
    writeOutput(outputDir, "src/utils.ts", "export const x = 1;\n");
    writeManifest(manifestDir, []);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert(report.unsupported_stacks.includes("rust"));
    assert(report.notes.some(n => n.includes("rust")));
  } finally { cleanup(); }
});

test("Mixed stack: TS + Rust processes TS, skips Rust", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/main.rs", "fn main() {}\n");
    writeOutput(outputDir, "src/app.ts", 'import { helper } from "./helper";\n');
    writeOutput(outputDir, "src/helper.ts", "export function helper() {}\n");
    writeManifest(manifestDir, ["typescript", "rust"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
    assert.equal(report.summary.files_scanned, 2); // TS only
    assert(report.unsupported_stacks.includes("rust"));
  } finally { cleanup(); }
});

test("File produced by task is in resolvable set", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./generated";\n');
    writeTask(manifestDir, "TASK-GEN-001", "src/generated.ts");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
    assert.equal(report.summary.resolved, 1);
  } finally { cleanup(); }
});

test("Multiple orphan imports all reported", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./missing1";\nimport { y } from "./missing2";\n');
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /err:/);
    assert.match(result, /2 orphan/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 2);
  } finally { cleanup(); }
});

test("JS with require() is parsed", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "index.js", 'const lib = require("./lib");\n');
    writeOutput(outputDir, "lib.js", "module.exports = {};\n");
    writeManifest(manifestDir, ["javascript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Custom report path is used", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./b";\n');
    writeOutput(outputDir, "src/b.ts", "export const x = 1;\n");
    writeManifest(manifestDir, ["typescript"]);

    const customReport = path.join(manifestDir, "custom-report.yaml");
    const result = runCheck(outputDir, manifestDir, `--report "${customReport}"`);
    assert.match(result, /ok:/);
    assert(fs.existsSync(customReport));

    const report = yaml.load(fs.readFileSync(customReport, "utf-8"));
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Empty output-dir with no files produces clean report", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.files_scanned, 0);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("node_modules and build dirs are skipped", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/app.ts", 'import { x } from "./helper";\n');
    writeOutput(outputDir, "src/helper.ts", "export const x = 1;\n");
    writeOutput(outputDir, "node_modules/pkg/index.js", "// ignored\n");
    writeOutput(outputDir, "build/bundle.js", "// ignored\n");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.files_scanned, 2); // only src/app and src/helper
  } finally { cleanup(); }
});

test("TS: index.ts resolution works", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./utils";\n');
    writeOutput(outputDir, "src/utils/index.ts", "export const x = 1;\n");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Report YAML is valid and loadable", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "./b";\n');
    writeOutput(outputDir, "src/b.ts", "export const x = 1;\n");
    writeManifest(manifestDir, ["typescript"]);

    runCheck(outputDir, manifestDir);
    const report = loadReport(outputDir, manifestDir);

    assert(report.summary);
    assert.equal(typeof report.summary.files_scanned, "number");
    assert.equal(typeof report.summary.orphans, "number");
    assert(Array.isArray(report.orphans));
    assert(Array.isArray(report.stack));
    assert(Array.isArray(report.unsupported_stacks));
  } finally { cleanup(); }
});

test("Export from syntax is parsed", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/re-export.ts", 'export { x } from "./utils";\n');
    writeOutput(outputDir, "src/utils.ts", "export const x = 1;\n");
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});

test("Scoped packages (@org/pkg) are treated as external", () => {
  const { outputDir, manifestDir, cleanup } = setupFixture();
  try {
    writeOutput(outputDir, "src/a.ts", 'import { x } from "@myorg/utils";\n');
    writeManifest(manifestDir, ["typescript"]);

    const result = runCheck(outputDir, manifestDir);
    assert.match(result, /ok:/);

    const report = loadReport(outputDir, manifestDir);
    assert.equal(report.summary.external_imports, 1);
    assert.equal(report.summary.orphans, 0);
  } finally { cleanup(); }
});
