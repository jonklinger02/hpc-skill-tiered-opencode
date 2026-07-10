#!/usr/bin/env node
/**
 * spec-defect-report.js — Generate SPEC-DEFECT.md halt artifact
 *
 * When Tier 4 recovery concludes the spec itself is structurally broken,
 * emit SPEC-DEFECT.md in a tight fixed template. This is a halt artifact.
 *
 * Usage:
 *   node scripts/spec-defect-report.js \
 *     [--input <defect.yaml>]         # structured inputs (optional)
 *     [--output <SPEC-DEFECT.md>]     # default ./SPEC-DEFECT.md
 *     [--diagnosis <s>]               # flag overrides input-file field
 *     [--build <path>]                # override build path
 *     [--halt-reason <s>]             # override halt reason
 *     [--iterations <N>]              # override recovery iterations
 *
 * Input schema (defect.yaml):
 *   diagnosis: "one-sentence diagnosis"          # required (flag or file)
 *   build: "/path/to/workspace"
 *   halt_reason: "Tier 4 diagnosis classification"
 *   recovery_iterations: 6
 *   implicated_sections:
 *     - spec_file: "Vektor-PRD.md"
 *       section: "4.3"
 *       excerpt: "quoted excerpt (<=100 words)"
 *   failure_signatures:
 *     - iteration: 1
 *       tier: "Tier 1"
 *       signature: "EvalAuditRow.labels undefined"
 *       tasks_affected: 7
 *   recommendation: "what would need to change for a future build to succeed"
 *
 * Output — EXACT template (fill from inputs; omit-gracefully when a field is absent)
 *
 * Exit codes:
 *   0 = success; output printed
 *   1 = error (missing diagnosis, file parse error, etc.)
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ── Argument Parsing ───────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    input: null,
    output: "./SPEC-DEFECT.md",
    diagnosis: null,
    build: null,
    haltReason: null,
    iterations: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
        parsed.input = args[++i];
        break;
      case "--output":
        parsed.output = args[++i];
        break;
      case "--diagnosis":
        parsed.diagnosis = args[++i];
        break;
      case "--build":
        parsed.build = args[++i];
        break;
      case "--halt-reason":
        parsed.haltReason = args[++i];
        break;
      case "--iterations":
        parsed.iterations = parseInt(args[++i], 10);
        break;
    }
  }

  return parsed;
}

// ── Load and merge input file ──────────────────────────────────────────────

function loadInputFile(inputPath) {
  try {
    const content = fs.readFileSync(inputPath, "utf-8");
    const data = yaml.load(content);
    return data || {};
  } catch (e) {
    console.error(`err:failed to parse input file ${inputPath}: ${e.message}`);
    process.exit(1);
  }
}

// ── Escape pipe characters in markdown table cells ─────────────────────────

function escapePipeInTableCell(text) {
  if (!text) return "";
  return String(text).replace(/\|/g, "\\|");
}

// ── Truncate text to N words ───────────────────────────────────────────────

function truncateToWords(text, maxWords) {
  if (!text) return "";
  const words = String(text).split(/\s+/);
  if (words.length <= maxWords) {
    return text;
  }
  return words.slice(0, maxWords).join(" ") + "…";
}

// ── Build the markdown report ──────────────────────────────────────────────

function buildReport(data) {
  const lines = [];

  // H1 title
  const diagnosis = data.diagnosis || "";
  lines.push(`# SPEC-DEFECT: ${diagnosis}`);
  lines.push("");

  // Metadata block
  if (data.build) {
    lines.push(`**Build:** ${data.build}`);
  }
  if (data.halt_reason) {
    lines.push(`**Halt reason:** ${data.halt_reason}`);
  }
  if (data.recovery_iterations !== undefined && data.recovery_iterations !== null) {
    lines.push(`**Recovery iterations attempted:** ${data.recovery_iterations}`);
  }
  lines.push(`**Halted at:** ${new Date().toISOString()}`);
  lines.push("");

  // Diagnosis section
  lines.push("## Diagnosis");
  lines.push("");
  if (data.diagnosis_detail) {
    lines.push(data.diagnosis_detail);
  } else if (data.diagnosis) {
    lines.push(data.diagnosis);
  }
  lines.push("");

  // Implicated spec sections
  lines.push("## Implicated spec sections");
  lines.push("");
  if (data.implicated_sections && Array.isArray(data.implicated_sections) && data.implicated_sections.length > 0) {
    for (const section of data.implicated_sections) {
      const specFile = section.spec_file || "";
      const sectionNum = section.section || "";
      const excerpt = section.excerpt || "";
      const briefExcerpt = truncateToWords(excerpt, 12);

      lines.push(`- **${specFile}:§${sectionNum}** — ${briefExcerpt}`);
      lines.push(`  > ${excerpt}`);
    }
  } else {
    lines.push("_None identified._");
  }
  lines.push("");

  // Failure signatures table
  lines.push("## Failure signatures across recovery");
  lines.push("");
  lines.push("| Iteration | Tier | Failure signature | Tasks affected |");
  lines.push("|---|---|---|---|");

  if (data.failure_signatures && Array.isArray(data.failure_signatures) && data.failure_signatures.length > 0) {
    for (const sig of data.failure_signatures) {
      const iteration = sig.iteration || "";
      const tier = sig.tier || "";
      const signature = escapePipeInTableCell(sig.signature || "");
      const tasksAffected = sig.tasks_affected !== undefined ? sig.tasks_affected : "";

      lines.push(`| ${iteration} | ${tier} | ${signature} | ${tasksAffected} |`);
    }
  } else {
    lines.push("| — | — | — | — |");
  }
  lines.push("");

  // Recommendation section
  lines.push("## Recommendation");
  lines.push("");
  if (data.recommendation) {
    lines.push(data.recommendation);
  }
  lines.push("");

  // Audit trail section
  lines.push("## Audit trail");
  lines.push("");
  lines.push("Full audit log: `wiki/autonomous-decisions.yaml`");
  lines.push("Full recovery history: `hpc-workspace.tier3-iteration-*/`");
  lines.push("");

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  // Load input file if provided
  let fileData = {};
  if (opts.input) {
    fileData = loadInputFile(opts.input);
  }

  // Merge file data with flag overrides
  const data = {
    ...fileData,
    ...(opts.diagnosis !== null && { diagnosis: opts.diagnosis }),
    ...(opts.build !== null && { build: opts.build }),
    ...(opts.haltReason !== null && { halt_reason: opts.haltReason }),
    ...(opts.iterations !== null && { recovery_iterations: opts.iterations }),
  };

  // Validate: diagnosis is required
  if (!data.diagnosis) {
    console.error("err:missing diagnosis (provide via --diagnosis flag or input file)");
    process.exit(1);
  }

  // Build markdown report
  const markdown = buildReport(data);

  // Write output file
  try {
    fs.writeFileSync(opts.output, markdown, "utf-8");
  } catch (e) {
    console.error(`err:failed to write output file ${opts.output}: ${e.message}`);
    process.exit(1);
  }

  // Count implicated sections and signatures
  const sectionsCount = (data.implicated_sections && Array.isArray(data.implicated_sections))
    ? data.implicated_sections.length
    : 0;
  const signaturesCount = (data.failure_signatures && Array.isArray(data.failure_signatures))
    ? data.failure_signatures.length
    : 0;

  // Success output
  console.log(`ok:SPEC-DEFECT written ${opts.output} (${sectionsCount} implicated sections, ${signaturesCount} signatures)`);
}

main();
