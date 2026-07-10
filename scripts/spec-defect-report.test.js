#!/usr/bin/env node
/**
 * spec-defect-report.test.js — Tests for spec-defect-report.js
 *
 * Tests SPEC-DEFECT markdown generation with various input combinations.
 * Uses node:test (built into Node ≥18) — no external deps.
 *
 * Run via:  node spec-defect-report.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SPEC_DEFECT_SCRIPT = path.resolve(__dirname, "spec-defect-report.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hpc-spec-defect-test-"));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Run spec-defect-report.js and return trimmed stdout.
 * Never throws — errors are captured and returned.
 */
function runSpecDefect(extraArgs = "") {
  try {
    return execSync(
      `node "${SPEC_DEFECT_SCRIPT}" ${extraArgs}`,
      { encoding: "utf-8", cwd: path.dirname(SPEC_DEFECT_SCRIPT) }
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim();
  }
}

/**
 * Create a temporary YAML input file with the given data structure.
 */
function createInputFile(dir, filename, data) {
  const inputPath = path.join(dir, filename);
  const lines = [];

  if (data.diagnosis) {
    lines.push(`diagnosis: "${data.diagnosis}"`);
  }
  if (data.build) {
    lines.push(`build: "${data.build}"`);
  }
  if (data.halt_reason) {
    lines.push(`halt_reason: "${data.halt_reason}"`);
  }
  if (data.recovery_iterations !== undefined) {
    lines.push(`recovery_iterations: ${data.recovery_iterations}`);
  }

  if (data.implicated_sections && Array.isArray(data.implicated_sections)) {
    lines.push("implicated_sections:");
    for (const section of data.implicated_sections) {
      lines.push("  - spec_file: \"" + section.spec_file + "\"");
      lines.push("    section: \"" + section.section + "\"");
      lines.push("    excerpt: \"" + section.excerpt.replace(/"/g, '\\"') + "\"");
    }
  }

  if (data.failure_signatures && Array.isArray(data.failure_signatures)) {
    lines.push("failure_signatures:");
    for (const sig of data.failure_signatures) {
      lines.push("  - iteration: " + sig.iteration);
      lines.push("    tier: \"" + sig.tier + "\"");
      lines.push("    signature: \"" + sig.signature.replace(/"/g, '\\"') + "\"");
      lines.push("    tasks_affected: " + sig.tasks_affected);
    }
  }

  if (data.recommendation) {
    lines.push(`recommendation: "${data.recommendation.replace(/"/g, '\\"')}"`);
  }

  const content = lines.join("\n") + "\n";
  fs.writeFileSync(inputPath, content, "utf-8");
  return inputPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test("spec-defect-report: full input file with 2 implicated sections and 2 signatures", () => {
  const dir = makeTempDir();
  try {
    const inputPath = createInputFile(dir, "defect.yaml", {
      diagnosis: "EvalAuditRow.labels undefined in all iterations",
      build: "/workspace/hpc-build-20260529",
      halt_reason: "Structural mismatch between Vektor spec and implementation",
      recovery_iterations: 6,
      implicated_sections: [
        {
          spec_file: "Vektor-PRD.md",
          section: "4.3",
          excerpt: "The EvalAuditRow structure must include a labels field for audit trail attribution.",
        },
        {
          spec_file: "API-Design.md",
          section: "2.1",
          excerpt: "All Row types inherit from BaseRow which provides standard metadata fields.",
        },
      ],
      failure_signatures: [
        {
          iteration: 1,
          tier: "Tier 1",
          signature: "EvalAuditRow.labels undefined",
          tasks_affected: 7,
        },
        {
          iteration: 2,
          tier: "Tier 2",
          signature: "TypeError: Cannot read property 'push' of undefined",
          tasks_affected: 3,
        },
      ],
      recommendation: "Add explicit labels field to EvalAuditRow schema in Vektor-PRD.md §4.3 and regenerate type stubs.",
    });

    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    const result = runSpecDefect(`--input "${inputPath}" --output "${outputPath}"`);

    assert.match(result, /^ok:/, "should output ok: message");
    assert.match(result, /SPEC-DEFECT written/, "should confirm file written");
    assert.match(result, /2 implicated sections/, "should report 2 implicated sections");
    assert.match(result, /2 signatures/, "should report 2 signatures");

    // Verify output file
    assert(fs.existsSync(outputPath), "output file should exist");
    const content = fs.readFileSync(outputPath, "utf-8");

    assert.match(content, /^# SPEC-DEFECT: /, "should start with H1 SPEC-DEFECT");
    assert.match(
      content,
      /EvalAuditRow\.labels undefined in all iterations/,
      "should contain diagnosis"
    );
    assert.match(content, /## Implicated spec sections/, "should have implicated sections heading");
    assert.match(content, /Vektor-PRD\.md:§4\.3/, "should reference first spec section");
    assert.match(content, /API-Design\.md:§2\.1/, "should reference second spec section");
    assert.match(content, /## Failure signatures across recovery/, "should have failure signatures heading");
    assert.match(content, /\| 1 \| Tier 1 \|/, "should have first signature row");
    assert.match(content, /\| 2 \| Tier 2 \|/, "should have second signature row");
    assert.match(
      content,
      /Add explicit labels field to EvalAuditRow schema/,
      "should contain recommendation"
    );
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: minimal input with only --diagnosis flag", () => {
  const dir = makeTempDir();
  try {
    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    const result = runSpecDefect(`--diagnosis "Test failure" --output "${outputPath}"`);

    assert.match(result, /^ok:/, "should output ok: message");

    // Verify output file
    assert(fs.existsSync(outputPath), "output file should exist");
    const content = fs.readFileSync(outputPath, "utf-8");

    assert.match(content, /^# SPEC-DEFECT: Test failure/, "should have H1 with diagnosis");
    assert.match(content, /_None identified\./, "should have 'None identified' for empty sections");
    assert.match(content, /\| — \| — \| — \| — \|/, "should have dashes row for empty signatures");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: pipe character escaping in failure signature", () => {
  const dir = makeTempDir();
  try {
    const inputPath = createInputFile(dir, "defect.yaml", {
      diagnosis: "Test pipe escaping",
      failure_signatures: [
        {
          iteration: 1,
          tier: "Tier 1",
          signature: "Error: foo | bar | baz",
          tasks_affected: 2,
        },
      ],
    });

    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    runSpecDefect(`--input "${inputPath}" --output "${outputPath}"`);

    const content = fs.readFileSync(outputPath, "utf-8");

    // Verify pipes are escaped in table cell
    assert.match(content, /Error: foo \\| bar \\| baz/, "should escape pipes in table cell");
    // Verify the raw pipe doesn't break the table
    const lines = content.split("\n");
    const tableLines = lines.filter((line) => line.includes("Error: foo"));
    assert(tableLines.length > 0, "should have table row with escaped pipes");
    // Count pipes in the row — should be 3 (separators) plus escaped ones
    assert(tableLines[0].match(/\|/g).length >= 4, "should maintain table structure");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: missing diagnosis returns error", () => {
  const dir = makeTempDir();
  try {
    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    const result = runSpecDefect(`--output "${outputPath}"`);

    assert.match(result, /err:/, "should output err: message");
    assert.match(result, /missing diagnosis/, "should mention missing diagnosis");
    assert(!fs.existsSync(outputPath), "output file should NOT exist on error");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: flag overrides input file values", () => {
  const dir = makeTempDir();
  try {
    const inputPath = createInputFile(dir, "defect.yaml", {
      diagnosis: "Original diagnosis",
      build: "/original/build",
      halt_reason: "Original reason",
      recovery_iterations: 3,
    });

    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    runSpecDefect(
      `--input "${inputPath}" --output "${outputPath}" --diagnosis "Overridden diagnosis" --build "/new/build"`
    );

    const content = fs.readFileSync(outputPath, "utf-8");

    assert.match(content, /# SPEC-DEFECT: Overridden diagnosis/, "should use flag diagnosis");
    assert.match(content, /\*\*Build:\*\* \/new\/build/, "should use flag build path");
    assert.match(content, /\*\*Recovery iterations attempted:\*\* 3/, "should keep file iterations");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: default output path is ./SPEC-DEFECT.md", () => {
  const dir = makeTempDir();
  try {
    // Create a simple wrapper script to test from the temp dir
    const wrapperPath = path.join(dir, "run-test.sh");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/bash\ncd "${dir}" && node "${SPEC_DEFECT_SCRIPT}" --diagnosis "Test"\n`,
      "utf-8"
    );
    fs.chmodSync(wrapperPath, 0o755);

    try {
      execSync(`bash "${wrapperPath}"`, { encoding: "utf-8" });
    } catch (e) {
      // Capture output even if it errors
    }

    const defaultPath = path.join(dir, "SPEC-DEFECT.md");
    assert(fs.existsSync(defaultPath), "file should exist at default path ./SPEC-DEFECT.md");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: timestamp is present in output", () => {
  const dir = makeTempDir();
  try {
    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    runSpecDefect(`--diagnosis "Test" --output "${outputPath}"`);

    const content = fs.readFileSync(outputPath, "utf-8");

    assert.match(
      content,
      /\*\*Halted at:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/,
      "should contain ISO timestamp"
    );
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: section excerpt truncation to 12-word brief", () => {
  const dir = makeTempDir();
  try {
    const inputPath = createInputFile(dir, "defect.yaml", {
      diagnosis: "Test excerpt truncation",
      implicated_sections: [
        {
          spec_file: "Test.md",
          section: "1.0",
          excerpt: "Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9 Word10 Word11 Word12 Word13 Word14 Word15",
        },
      ],
    });

    const outputPath = path.join(dir, "SPEC-DEFECT.md");
    runSpecDefect(`--input "${inputPath}" --output "${outputPath}"`);

    const content = fs.readFileSync(outputPath, "utf-8");

    // Brief should have first 12 words plus ellipsis
    assert.match(content, /Word1 Word2 Word3 Word4 Word5 Word6 Word7 Word8 Word9 Word10 Word11 Word12…/, "brief should be truncated to 12 words");
    // Full excerpt should still be there in blockquote
    assert.match(content, /> Word1 Word2 Word3/, "full excerpt should be in blockquote");
  } finally {
    rm(dir);
  }
});

test("spec-defect-report: clean up temp dirs in finally blocks", () => {
  const dir = makeTempDir();
  const dirExists = fs.existsSync(dir);
  rm(dir);
  const dirGone = !fs.existsSync(dir);
  assert(dirExists && dirGone, "temp dir cleanup should work");
});
