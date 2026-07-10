#!/usr/bin/env node
/**
 * inject-req-ids.test.js
 *
 * Tests for inject-req-ids.js.
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via:    node scripts/inject-req-ids.test.js
 * Or:        ./run-tests.sh
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const INJECT_SCRIPT = path.resolve(__dirname, "inject-req-ids.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-inject-req-ids-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run inject-req-ids.js and return trimmed stdout.
 * Never throws — errors are captured in output.
 */
function runInject(prdFile, outputFile) {
  try {
    return execSync(`node "${INJECT_SCRIPT}" --prd "${prdFile}" --output "${outputFile}"`, {
      encoding: "utf-8",
    }).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("inject-req-ids: PRD with zero REQ-IDs and several leaf headings → synthesize REQ-AUTO IDs", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Product Requirements Document

## Feature A
This is a feature that needs a requirement ID.

### Sub-feature A1
Some details about A1.

## Feature B
Another feature without an ID.

### Sub-feature B1
Details about B1.

### Sub-feature B2
More details.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // Check stdout format
    assert.match(stdout, /^ok:/, "stdout should start with 'ok:'");
    assert.match(stdout, /authored=0/, "should report 0 authored IDs");
    assert.match(stdout, /synthesized=\d+/, "should report synthesized IDs");

    // Check output file exists and contains synthesized IDs
    assert.ok(fs.existsSync(outputFile), "output file should exist");
    const outputContent = fs.readFileSync(outputFile, "utf-8");

    assert.match(outputContent, /REQ-AUTO-001/, "should contain REQ-AUTO-001");
    assert.match(outputContent, /REQ-AUTO-/, "should contain synthesized IDs");
    assert.match(
      outputContent,
      /<!-- DERIVED PRD/,
      "should contain derived PRD header comment"
    );

    // Original file should be unchanged
    const originalNow = fs.readFileSync(prdFile, "utf-8");
    assert.equal(originalNow, prdContent, "original file should not be modified");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: PRD where every section has REQ-\\d+ → synthesized=0", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Product Requirements Document

## Feature A (REQ-001)
This feature has an ID.

### Sub-feature A1 (REQ-002)
Some details about A1.

## Feature B (REQ-003)
Another feature with an ID.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // Check stdout
    assert.match(stdout, /^ok:/, "should succeed");
    assert.match(stdout, /authored=3/, "should report 3 authored IDs");
    assert.match(stdout, /synthesized=0/, "should report 0 synthesized IDs");

    // Output should not have REQ-AUTO
    const outputContent = fs.readFileSync(outputFile, "utf-8");
    assert.doesNotMatch(outputContent, /REQ-AUTO-/, "should not synthesize when all have IDs");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: MIXED PRD (some sections have IDs, others don't) → preserve authored, synthesize missing", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Product Requirements Document

## Feature A (REQ-001)
This feature has an ID.

## Feature B
This feature does not have an ID.

## Feature C (REQ-002)
Another feature with an ID.

## Feature D
Yet another feature without an ID.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // Check stdout
    assert.match(stdout, /^ok:/, "should succeed");
    assert.match(stdout, /authored=2/, "should report 2 authored IDs");
    assert.match(stdout, /synthesized=2/, "should report 2 synthesized IDs (Features B and D)");

    // Output should preserve authored IDs and synthesize missing ones
    const outputContent = fs.readFileSync(outputFile, "utf-8");
    assert.match(outputContent, /Feature A.*REQ-001/, "should preserve REQ-001");
    assert.match(outputContent, /Feature B.*REQ-AUTO-001/, "should synthesize REQ-AUTO-001 for B");
    assert.match(outputContent, /Feature C.*REQ-002/, "should preserve REQ-002");
    assert.match(outputContent, /Feature D.*REQ-AUTO-002/, "should synthesize REQ-AUTO-002 for D");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Missing --prd flag → err:", () => {
  const dir = makeTempDir();
  try {
    const outputFile = path.join(dir, "out.md");
    const stdout = runInject(undefined, outputFile);

    assert.match(stdout, /^err:/, "should print err:");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: --prd file does not exist → err:", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "nonexistent.md");
    const outputFile = path.join(dir, "out.md");

    // Manually construct the command since runInject expects both args
    const stdout = (() => {
      try {
        return execSync(`node "${INJECT_SCRIPT}" --prd "${prdFile}" --output "${outputFile}"`, {
          encoding: "utf-8",
        }).trim();
      } catch (e) {
        return ((e.stdout || "") + (e.stderr || "")).trim();
      }
    })();

    assert.match(stdout, /^err:/, "should print err:");
    assert.match(stdout, /not found/, "error message should indicate file not found");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Output with nested subdirectories (parent dirs don't exist) → create them", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "deep", "nested", "dir", "out.md");

    const prdContent = `# Product Requirements Document

## Feature A
Needs an ID.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    assert.match(stdout, /^ok:/, "should succeed");
    assert.ok(fs.existsSync(outputFile), "output file should exist in nested directory");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Heading without REQ-ID → synthesized ID appended to heading text", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Product Requirements Document

## Feature A
Some description.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    runInject(prdFile, outputFile);

    const outputContent = fs.readFileSync(outputFile, "utf-8");
    // The heading should be modified to include the synthesized ID
    assert.match(outputContent, /^## Feature A \(REQ-AUTO-001\)/m, "heading should include ID in parens");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Leaf heading detection: nested headings are not leaves", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Document

## Section A
Parent section (level 2).

### Subsection A1
Child section (level 3).

#### Subsubsection A1a
Grandchild (level 4).

## Section B
Another level 2 section.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // Only the leaf headings should get IDs:
    // - "Subsubsection A1a" (level 4, no deeper heading follows)
    // - "Section B" (level 2, no deeper heading follows it)
    assert.match(stdout, /synthesized=2/, "should synthesize 2 IDs for the 2 leaf headings");

    const outputContent = fs.readFileSync(outputFile, "utf-8");
    assert.match(
      outputContent,
      /#### Subsubsection A1a.*REQ-AUTO-001/,
      "deepest level should get first ID"
    );
    assert.match(outputContent, /## Section B.*REQ-AUTO-002/, "second leaf should get second ID");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: REQ-AUTO- prefix should not be counted as authored", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    // Simulate a re-run: the PRD already has REQ-AUTO-001 from previous synthesis
    const prdContent = `# Product Requirements Document

## Feature A (REQ-AUTO-001)
Already synthesized.

## Feature B
Needs synthesis.
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // REQ-AUTO-001 should NOT count as an authored ID
    assert.match(stdout, /authored=0/, "REQ-AUTO should not count as authored");
    // Feature B should still get synthesized
    assert.match(stdout, /synthesized=/, "should synthesize for Feature B");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Empty PRD with no headings → no synthesis, no error", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `Some plain text with no headings.`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    assert.match(stdout, /^ok:/, "should succeed");
    assert.match(stdout, /authored=0 synthesized=0/, "should have no IDs to add");

    const outputContent = fs.readFileSync(outputFile, "utf-8");
    assert.match(outputContent, /DERIVED PRD/, "should still add header comment");
  } finally {
    rm(dir);
  }
});

test("inject-req-ids: Multiple REQ-\\d+ IDs in same section → all preserved", () => {
  const dir = makeTempDir();
  try {
    const prdFile = path.join(dir, "prd.md");
    const outputFile = path.join(dir, "out.md");

    const prdContent = `# Document

## Feature A
Requirement (REQ-001) and another (REQ-002).
`;

    fs.writeFileSync(prdFile, prdContent, "utf-8");

    const stdout = runInject(prdFile, outputFile);

    // Should detect both REQ-001 and REQ-002 as authored
    assert.match(stdout, /authored=2/, "should detect both authored IDs");
    assert.match(stdout, /synthesized=0/, "should not synthesize when IDs present");
  } finally {
    rm(dir);
  }
});
