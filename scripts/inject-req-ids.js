#!/usr/bin/env node
/**
 * inject-req-ids.js
 *
 * Ensures every acceptance-shaped requirement in a PRD markdown file has a REQ-NNN ID.
 * Synthesizes REQ-AUTO-NNN IDs for leaf-level headings that lack an authored REQ-\d+ ID,
 * while preserving any author-supplied REQ-\d+ IDs.
 *
 * Usage:
 *   node scripts/inject-req-ids.js --prd <input/prd.md> --output <output/derived-prd.md>
 *
 * Behavior:
 * 1. Parse CLI args; require --prd and --output. File must exist.
 * 2. Read PRD markdown. Find all authored REQ-\d+ IDs (excluding REQ-AUTO-).
 * 3. Walk heading tree; identify leaf-level headings.
 * 4. For each leaf, check if its section body contains a REQ-\d+ ID.
 *    - If yes, leave as-is.
 *    - If no, synthesize REQ-AUTO-NNN and append to heading text.
 * 5. Write output with header comment noting counts.
 * 6. Print "ok:authored=A synthesized=B" on success, or "err:<msg>" on failure.
 */

const fs = require("fs");
const path = require("path");

// ── CLI Arg Parsing ───────────────────────────────────────────────────────

let prdFile = null;
let outputFile = null;

for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--prd" && i + 1 < process.argv.length) {
    prdFile = process.argv[++i];
  } else if (arg === "--output" && i + 1 < process.argv.length) {
    outputFile = process.argv[++i];
  }
}

if (!prdFile || !outputFile) {
  console.log("err:missing --prd or --output");
  process.exit(1);
}

if (!fs.existsSync(prdFile)) {
  console.log(`err:file not found: ${prdFile}`);
  process.exit(1);
}

// ── Read PRD ───────────────────────────────────────────────────────────────

let prdContent;
try {
  prdContent = fs.readFileSync(prdFile, "utf-8");
} catch (e) {
  console.log(`err:failed to read ${prdFile}: ${e.message}`);
  process.exit(1);
}

// ── Find Authored REQ-\d+ IDs ──────────────────────────────────────────────

const authoredReqPattern = /REQ-(\d+)/g;
const authoredIds = new Set();
let match;
while ((match = authoredReqPattern.exec(prdContent)) !== null) {
  authoredIds.add(match[0]); // e.g., "REQ-001"
}

// ── Parse Headings ────────────────────────────────────────────────────────

const lines = prdContent.split("\n");

// Parse headings: each heading has level (1-6), lineNumber, and text
const headings = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const match = /^(#+)\s+(.*)$/.exec(line);
  if (match) {
    const level = match[1].length;
    const text = match[2];
    headings.push({ level, text, lineNumber: i, originalText: text });
  }
}

// ── Identify Leaf Headings ─────────────────────────────────────────────────

// A heading is "leaf-level" if no deeper heading is nested under it before
// the next heading of equal or shallower depth.

const leafHeadings = [];
for (let i = 0; i < headings.length; i++) {
  const current = headings[i];
  const nextAtEqualOrShallower = headings.slice(i + 1).find((h) => h.level <= current.level);

  // Check if there's any deeper heading between current and nextAtEqualOrShallower
  const hasDeeper = headings.slice(i + 1).some((h) => {
    if (nextAtEqualOrShallower && h.lineNumber >= nextAtEqualOrShallower.lineNumber) {
      return false; // past the boundary
    }
    return h.level > current.level;
  });

  if (!hasDeeper) {
    leafHeadings.push(current);
  }
}

// ── Process Leaf Headings ──────────────────────────────────────────────────

let synthesizedCount = 0;
const modifiedLines = lines.slice(); // Copy for modification

for (const leafHeading of leafHeadings) {
  // Find the section: from heading (inclusive) to next heading (exclusive)
  const headingLineNumber = leafHeading.lineNumber;
  const nextHeadingLineNumber = headings
    .filter((h) => h.lineNumber > headingLineNumber)
    .map((h) => h.lineNumber)[0];

  const sectionEndLine = nextHeadingLineNumber !== undefined ? nextHeadingLineNumber : lines.length;
  const sectionLines = modifiedLines.slice(headingLineNumber, sectionEndLine);
  const sectionText = sectionLines.join("\n");

  // Check if section already has a REQ id — authored REQ-\d+ OR a previously
  // synthesized REQ-AUTO-\d+ (including in the heading itself) — so re-runs
  // are idempotent and never stack a second REQ-AUTO id onto a heading.
  const hasAuthoredId = /REQ-(?:AUTO-)?\d+/.test(sectionText);

  if (!hasAuthoredId) {
    // Synthesize new ID
    synthesizedCount++;
    const newId = `REQ-AUTO-${String(synthesizedCount).padStart(3, "0")}`;
    const updatedHeadingText = `${leafHeading.originalText} (${newId})`;

    // Update the heading line in modifiedLines
    modifiedLines[headingLineNumber] = modifiedLines[headingLineNumber].replace(
      /^(#+\s+).*$/,
      `$1${updatedHeadingText}`
    );
  }
}

// ── Generate Output ───────────────────────────────────────────────────────

const authoredCount = authoredIds.size;
const headerComment = `<!-- DERIVED PRD — REQ-AUTO IDs synthesized by inject-req-ids.js. Authored REQ-IDs: ${authoredCount}. Synthesized REQ-AUTO IDs: ${synthesizedCount}. -->`;
const outputContent = [headerComment, "", modifiedLines.join("\n")].join("\n");

// ── Write Output ───────────────────────────────────────────────────────────

const outputDir = path.dirname(outputFile);
try {
  if (outputDir !== ".") {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputFile, outputContent, "utf-8");
} catch (e) {
  console.log(`err:failed to write ${outputFile}: ${e.message}`);
  process.exit(1);
}

// ── Print Result ───────────────────────────────────────────────────────────

console.log(`ok:authored=${authoredCount} synthesized=${synthesizedCount}`);
