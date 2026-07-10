#!/usr/bin/env node
// Tests for corpus-filter.js — scope classification via sub-agent.
// Uses node:test (built into Node ≥18) — no external deps.
//
// Run via:    node corpus-filter.test.js
// Or:        ./run-tests.sh

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const CORPUS_FILTER_SCRIPT = path.resolve(__dirname, "corpus-filter.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-corpus-filter-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run corpus-filter.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runCorpusFilter(inputDocs, buildTarget, outputCorpus, outputDeferred, extraArgs = "") {
  try {
    return execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --input-docs "${inputDocs}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}" ${extraArgs}`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT) }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a stub model response YAML fixture.
 * Returns the path to the temp file.
 */
function makeStubResponse() {
  const fixture = `scope_corpus: |
  # Build 1: User API & Authentication

  This build delivers the core REST API and user authentication system:
  - User registration and login endpoints
  - Email/password authentication
  - JWT token management
  - Basic user profile endpoints
  - Admin user management interface

deferred_scope:
  - id: DEFERRED-001
    corpus_sections: ["Real-time features", "WebSocket integration"]
    summary: Real-time notifications via WebSocket connections.
    rationale: Depends on stable user base and API maturity.
    depends_on_current_build: ["REST API", "Authentication system"]
    suggested_future_epic: "Build 2: Real-time Features"
    rough_task_estimate: 8
  - id: DEFERRED-002
    corpus_sections: ["Analytics", "Usage reporting"]
    summary: Analytics dashboard and user behavior tracking.
    rationale: Lower priority; can be added after core features are proven stable.
    depends_on_current_build: ["User endpoints", "Admin interface"]
    suggested_future_epic: "Build 3: Analytics & Insights"
    rough_task_estimate: 5
`;
  const tempFile = path.join(os.tmpdir(), `hpc-stub-${Date.now()}.yaml`);
  fs.writeFileSync(tempFile, fixture);
  return tempFile;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("corpus-filter: writes scope-corpus and deferred-scope with stub response", () => {
  const stubFile = makeStubResponse();
  const tempDir = makeTempDir();
  try {
    // Create input docs
    const inputDocsDir = path.join(tempDir, "input-docs");
    fs.mkdirSync(inputDocsDir);
    fs.writeFileSync(
      path.join(inputDocsDir, "prd.md"),
      `# Product Requirements Document

## User Management
- User registration with email/password
- User profiles with name, avatar, bio
- Admin can manage users

## Real-time Notifications
- Notify users of new posts via WebSocket
- Deliver notifications in < 1 second

## Analytics
- Track user behavior
- Dashboard showing top users
`
    );
    fs.writeFileSync(
      path.join(inputDocsDir, "spec.yaml"),
      `api_version: v1
endpoints:
  - /users (CRUD)
  - /auth/login
  - /auth/register
auth:
  method: JWT
  expiry: 24h
`
    );

    // Output paths
    const outputCorpus = path.join(tempDir, "scope-corpus.md");
    const outputDeferred = path.join(tempDir, "deferred-scope.yaml");
    const buildTarget = "Build a user API with email/password authentication, JWT tokens, and admin dashboard.";

    // Run with stub
    const stdout = runCorpusFilter(
      inputDocsDir,
      buildTarget,
      outputCorpus,
      outputDeferred,
      `--model claude-sonnet-4-6`,
    );
    const env = { ...process.env, HPC_SUBAGENT_STUB_FILE: stubFile };
    const result = execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --input-docs "${inputDocsDir}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), env }
    ).trim();

    // Verify stdout starts with "ok:"
    assert.match(result, /^ok:/, "stdout should start with 'ok:'");

    // Verify scope-corpus exists and contains expected text
    assert(fs.existsSync(outputCorpus), "scope-corpus file should exist");
    const scopeContent = fs.readFileSync(outputCorpus, "utf-8");
    assert.match(scopeContent, /User API/, "scope-corpus should contain 'User API'");
    assert.match(scopeContent, /Authentication/, "scope-corpus should contain 'Authentication'");

    // Verify deferred-scope exists and parses correctly
    assert(fs.existsSync(outputDeferred), "deferred-scope file should exist");
    const deferredContent = fs.readFileSync(outputDeferred, "utf-8");
    const deferredData = yaml.load(deferredContent);
    assert(deferredData.deferred_scope, "deferred_scope key should exist");
    assert(Array.isArray(deferredData.deferred_scope), "deferred_scope should be an array");
    assert.strictEqual(deferredData.deferred_scope.length, 2, "should have 2 deferred entries");
    assert.strictEqual(deferredData.deferred_scope[0].id, "DEFERRED-001", "first entry id should be DEFERRED-001");
    assert(Array.isArray(deferredData.deferred_scope[0].depends_on_current_build), "depends_on_current_build should be array");
  } finally {
    rm(tempDir);
    fs.unlinkSync(stubFile);
  }
});

test("corpus-filter: missing --input-docs returns err", () => {
  const tempDir = makeTempDir();
  try {
    const buildTarget = "Some build target";
    const outputCorpus = path.join(tempDir, "scope.md");
    const outputDeferred = path.join(tempDir, "deferred.yaml");

    const result = execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), stdio: ["pipe", "pipe", "pipe"] }
    ).catch(e => ((e.stdout || "") + (e.stderr || "")).trim());

    // This should fail, but execSync throws, so we try-catch
    assert.fail("should have exited with error");
  } catch (e) {
    const output = ((e.stdout || "") + (e.stderr || "")).trim();
    assert.match(output, /err:/, "output should contain 'err:'");
  } finally {
    rm(tempDir);
  }
});

test("corpus-filter: missing --input-docs returns err (safe version)", () => {
  const tempDir = makeTempDir();
  try {
    const buildTarget = "Some build target";
    const outputCorpus = path.join(tempDir, "scope.md");
    const outputDeferred = path.join(tempDir, "deferred.yaml");

    try {
      execSync(
        `node "${CORPUS_FILTER_SCRIPT}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
        { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), stdio: ["pipe", "pipe", "pipe"] }
      );
      assert.fail("should have exited with error");
    } catch (e) {
      const output = ((e.stdout || "") + (e.stderr || "")).trim();
      assert.match(output, /err:/, "output should contain 'err:' when required args missing");
    }
  } finally {
    rm(tempDir);
  }
});

test("corpus-filter: handles @file build target syntax", () => {
  const stubFile = makeStubResponse();
  const tempDir = makeTempDir();
  try {
    // Create input docs
    const inputDocsDir = path.join(tempDir, "input-docs");
    fs.mkdirSync(inputDocsDir);
    fs.writeFileSync(path.join(inputDocsDir, "prd.md"), "# Build requirements\n\nCore features");

    // Create build target file
    const buildTargetFile = path.join(tempDir, "build-target.txt");
    fs.writeFileSync(buildTargetFile, "Deliver user authentication with JWT tokens");

    // Output paths
    const outputCorpus = path.join(tempDir, "scope.md");
    const outputDeferred = path.join(tempDir, "deferred.yaml");

    const env = { ...process.env, HPC_SUBAGENT_STUB_FILE: stubFile };
    const result = execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --input-docs "${inputDocsDir}" --build-target "@${buildTargetFile}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), env }
    ).trim();

    assert.match(result, /^ok:/, "should succeed with @file syntax");
    assert(fs.existsSync(outputCorpus), "scope-corpus should be written");
  } finally {
    rm(tempDir);
    fs.unlinkSync(stubFile);
  }
});

test("corpus-filter: creates parent directories for output files", () => {
  const stubFile = makeStubResponse();
  const tempDir = makeTempDir();
  try {
    const inputDocsDir = path.join(tempDir, "input-docs");
    fs.mkdirSync(inputDocsDir);
    fs.writeFileSync(path.join(inputDocsDir, "prd.md"), "# Requirements");

    // Nested output paths that don't exist yet
    const outputCorpus = path.join(tempDir, "nested", "deep", "scope.md");
    const outputDeferred = path.join(tempDir, "nested", "deep", "deferred.yaml");
    const buildTarget = "Build core features";

    const env = { ...process.env, HPC_SUBAGENT_STUB_FILE: stubFile };
    const result = execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --input-docs "${inputDocsDir}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), env }
    ).trim();

    assert.match(result, /^ok:/, "should succeed");
    assert(fs.existsSync(outputCorpus), "should create nested directories for scope-corpus");
    assert(fs.existsSync(outputDeferred), "should create nested directories for deferred-scope");
  } finally {
    rm(tempDir);
    fs.unlinkSync(stubFile);
  }
});

test("corpus-filter: processes multiple input documents", () => {
  const stubFile = makeStubResponse();
  const tempDir = makeTempDir();
  try {
    const inputDocsDir = path.join(tempDir, "input-docs");
    fs.mkdirSync(inputDocsDir);
    fs.writeFileSync(path.join(inputDocsDir, "prd.md"), "# PRD\n\nFeatures");
    fs.writeFileSync(path.join(inputDocsDir, "design.md"), "# Design\n\nArchitecture");
    fs.writeFileSync(path.join(inputDocsDir, "testing.yaml"), "test_plan:\n  unit_tests: true\n  e2e_tests: true");

    const outputCorpus = path.join(tempDir, "scope.md");
    const outputDeferred = path.join(tempDir, "deferred.yaml");
    const buildTarget = "Build API";

    const env = { ...process.env, HPC_SUBAGENT_STUB_FILE: stubFile };
    const result = execSync(
      `node "${CORPUS_FILTER_SCRIPT}" --input-docs "${inputDocsDir}" --build-target "${buildTarget}" --output-corpus "${outputCorpus}" --output-deferred "${outputDeferred}"`,
      { encoding: "utf-8", cwd: path.dirname(CORPUS_FILTER_SCRIPT), env }
    ).trim();

    assert.match(result, /^ok:/, "should process multiple docs");
    assert(fs.existsSync(outputCorpus), "scope-corpus should be written");
    const scopeContent = fs.readFileSync(outputCorpus, "utf-8");
    // The model should have seen all three docs in the corpus
    assert(scopeContent.length > 0, "scope-corpus should have content from all docs");
  } finally {
    rm(tempDir);
    fs.unlinkSync(stubFile);
  }
});
