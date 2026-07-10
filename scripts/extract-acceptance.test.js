#!/usr/bin/env node
/**
 * extract-acceptance.test.js — Tests for extract-acceptance.js
 *
 * Tests acceptance criteria extraction, normalization, and edge cases.
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via:  node extract-acceptance.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const EXTRACT_SCRIPT = path.resolve(__dirname, "extract-acceptance.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-extract-acceptance-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run extract-acceptance.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runExtract(prdFile, outputFile, extraArgs = "", env = {}) {
  try {
    const mergedEnv = { ...process.env, ...env };
    return execSync(
      `node "${EXTRACT_SCRIPT}" --prd "${prdFile}" --output "${outputFile}" ${extraArgs}`,
      { encoding: "utf-8", env: mergedEnv }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a fixture YAML file with canned model response.
 */
function createStubFixture(dir, withIds = true) {
  const criteria = [
    {
      id: withIds ? "AC-001" : undefined,
      source: "REQ-USER-001",
      text: "Users can log in with email and password",
      classification: "observable",
      judgeable_directly: true,
      requires_subcriteria: false,
    },
    {
      id: withIds ? "AC-002" : undefined,
      source: "REQ-ADMIN-001",
      text: "Admin dashboard enforces role-based access control",
      classification: "requires-decomposition",
      judgeable_directly: false,
      requires_subcriteria: true,
      subcriteria: [
        "Admin can create and edit user roles",
        "Users cannot access sections for roles they do not have",
        "Role assignments persist across sessions",
      ],
    },
  ];

  const fixture = { acceptance_criteria: criteria };
  const fixtureFile = path.join(dir, "model-response.yaml");
  fs.writeFileSync(fixtureFile, yaml.dump(fixture));
  return fixtureFile;
}

// ═══════════════════════════════════════════════════════════════════════════
// BASIC FUNCTIONALITY
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: valid PRD with model stub produces ok message", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# PRD\n\nUser login via email/password.\n");

    const stubFile = createStubFixture(dir);
    const result = runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    assert.match(result, /^ok:/, "should output ok: message");
    assert.match(result, /2 criteria/, "should count 2 criteria");
    assert.match(result, /observable/, "should mention observable count");
    assert.match(result, /requires-decomposition/, "should mention requires-decomposition count");
  } finally { rm(dir); }
});

test("extract-acceptance: output file is created with valid YAML", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# Requirements\n\nLogin support.\n");

    const stubFile = createStubFixture(dir);
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    assert.ok(fs.existsSync(outputFile), "output file should be created");
    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = yaml.load(content);
    assert.ok(Array.isArray(parsed.acceptance_criteria), "should have acceptance_criteria array");
    assert.equal(parsed.acceptance_criteria.length, 2, "should have 2 criteria");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ID ASSIGNMENT
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: missing ids are assigned (AC-001, AC-002, ...)", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# Requirements\n");

    const stubFile = createStubFixture(dir, false); // no ids in fixture
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = yaml.load(content);
    assert.equal(parsed.acceptance_criteria[0].id, "AC-001", "first id should be AC-001");
    assert.equal(parsed.acceptance_criteria[1].id, "AC-002", "second id should be AC-002");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLASSIFICATION AND CONSISTENCY
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: observable criteria has judgeable_directly=true, requires_subcriteria=false", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# Requirements\n");

    const stubFile = createStubFixture(dir);
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = yaml.load(content);
    const observable = parsed.acceptance_criteria.find(c => c.classification === "observable");
    assert.ok(observable, "should have observable criterion");
    assert.equal(observable.judgeable_directly, true, "observable should have judgeable_directly=true");
    assert.equal(observable.requires_subcriteria, false, "observable should have requires_subcriteria=false");
  } finally { rm(dir); }
});

test("extract-acceptance: requires-decomposition criteria has judgeable_directly=false, requires_subcriteria=true", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# Requirements\n");

    const stubFile = createStubFixture(dir);
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = yaml.load(content);
    const decomposed = parsed.acceptance_criteria.find(c => c.classification === "requires-decomposition");
    assert.ok(decomposed, "should have requires-decomposition criterion");
    assert.equal(decomposed.judgeable_directly, false, "requires-decomposition should have judgeable_directly=false");
    assert.equal(decomposed.requires_subcriteria, true, "requires-decomposition should have requires_subcriteria=true");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUBCRITERIA PRESERVATION
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: requires-decomposition entries retain their subcriteria", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# Requirements\n");

    const stubFile = createStubFixture(dir);
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    const content = fs.readFileSync(outputFile, "utf-8");
    const parsed = yaml.load(content);
    const decomposed = parsed.acceptance_criteria.find(c => c.classification === "requires-decomposition");
    assert.ok(Array.isArray(decomposed.subcriteria), "should have subcriteria array");
    assert.equal(decomposed.subcriteria.length, 3, "should have 3 subcriteria");
    assert.match(decomposed.subcriteria[0], /create and edit/, "subcriteria should be preserved exactly");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: missing --prd flag returns err:", () => {
  const dir = makeTempDir();
  try {
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    const result = runExtract("", outputFile, "");
    assert.match(result, /^err:/, "should return err: without --prd");
    assert.match(result, /missing required arguments/, "should mention missing arguments");
  } finally { rm(dir); }
});

test("extract-acceptance: missing --output flag returns err:", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    fs.writeFileSync(prdFile, "# PRD\n");
    const result = runExtract(prdFile, "", "");
    assert.match(result, /^err:/, "should return err: without --output");
  } finally { rm(dir); }
});

test("extract-acceptance: nonexistent PRD file returns err:", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "nonexistent.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    const result = runExtract(prdFile, outputFile, "");
    assert.match(result, /^err:/, "should return err:");
    assert.match(result, /prd file not found/, "should mention file not found");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL SCOPE-CORPUS
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: --scope-corpus is optional; works without it", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# PRD\n\nFeatures...\n");

    const stubFile = createStubFixture(dir);
    const result = runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });
    assert.match(result, /^ok:/, "should work without --scope-corpus");
  } finally { rm(dir); }
});

test("extract-acceptance: --scope-corpus is read if provided and exists", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const corpusFile = path.join(dir, "scope-corpus.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# PRD\n");
    fs.writeFileSync(corpusFile, "# Scope\n\nIn-scope items...\n");

    const stubFile = createStubFixture(dir);
    const result = runExtract(
      prdFile,
      outputFile,
      `--scope-corpus "${corpusFile}"`,
      { HPC_SUBAGENT_STUB_FILE: stubFile }
    );
    assert.match(result, /^ok:/, "should work with --scope-corpus");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT DIRECTORY CREATION
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: creates parent directories if they don't exist", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "manifest", "subdir", "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# PRD\n");

    const stubFile = createStubFixture(dir);
    runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });

    assert.ok(fs.existsSync(outputFile), "output file should exist with parent dirs created");
  } finally { rm(dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY COUNTING
// ═══════════════════════════════════════════════════════════════════════════

test("extract-acceptance: ok message includes correct counts (2 observable + 0 decomposition)", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "acceptance-criteria.yaml");
    fs.writeFileSync(prdFile, "# PRD\n");

    const allObservable = {
      acceptance_criteria: [
        {
          id: "AC-001",
          source: "REQ-1",
          text: "Criterion 1",
          classification: "observable",
          judgeable_directly: true,
          requires_subcriteria: false,
        },
        {
          id: "AC-002",
          source: "REQ-2",
          text: "Criterion 2",
          classification: "observable",
          judgeable_directly: true,
          requires_subcriteria: false,
        },
      ],
    };
    const stubFile = path.join(dir, "stub.yaml");
    fs.writeFileSync(stubFile, yaml.dump(allObservable));

    const result = runExtract(prdFile, outputFile, "", { HPC_SUBAGENT_STUB_FILE: stubFile });
    assert.match(result, /2 criteria.*2 observable.*0 requires-decomposition/, "should count 2 observable, 0 decomposition");
  } finally { rm(dir); }
});
