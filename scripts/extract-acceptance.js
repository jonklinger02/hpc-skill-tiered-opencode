#!/usr/bin/env node
/**
 * extract-acceptance.js — Extract and classify acceptance criteria from PRD.
 *
 * Pulls every acceptance criterion out of the PRD / scope-corpus and classifies
 * it as `observable` (directly judgeable against a running app) or
 * `requires-decomposition` (needs explicit sub-criteria).
 *
 * Usage:
 *   node scripts/extract-acceptance.js \
 *     --prd <file> \
 *     [--scope-corpus <file>] \
 *     --output <manifest/acceptance-criteria.yaml> \
 *     [--model claude-sonnet-4-6]
 *
 * Returns "ok:<summary>" or "err:<description>"
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { resolveModel } = require("./lib/models.js");
const { callAgent } = require("./lib/opencode-client");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--prd":           parsed.prd = args[++i]; break;
      case "--scope-corpus":  parsed.scopeCorpus = args[++i]; break;
      case "--output":        parsed.output = args[++i]; break;
      case "--model":         parsed.model = args[++i]; break;
    }
  }
  return parsed;
}

/**
 * Call the Claude model as a sub-agent via the OpenCode serve API.
 * Reads HPC_SUBAGENT_STUB_FILE env var for offline testing.
 */
async function callModel(model, systemPrompt, userMessage) {
  // Offline/test stub: read a canned model response instead of spawning claude.
  if (process.env.HPC_SUBAGENT_STUB_FILE) {
    try { return { text: fs.readFileSync(process.env.HPC_SUBAGENT_STUB_FILE, "utf-8") }; }
    catch (e) { return { error: `stub read failed: ${e.message}` }; }
  }
  return callAgent({
    role: "acceptance_extract",
    model: resolveModel(model),
    systemPrompt,
    userMessage,
    timeoutMs: 1500000,
    tools: null,
    effort: null,
  });
}

/**
 * Strip leading/trailing markdown fences from text.
 */
function stripFences(text) {
  let result = text.trim();
  // Remove opening fence (```yaml or ``` or similar)
  result = result.replace(/^```[^\n]*\n?/, "");
  // Remove closing fence
  result = result.replace(/\n?```\s*$/, "");
  return result.trim();
}

/**
 * Normalize and validate acceptance criteria entries.
 * Assigns missing ids, coerces classification to valid values, ensures consistency.
 */
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];

  return entries.map((entry, idx) => {
    // Assign id if missing
    if (!entry.id) {
      entry.id = `AC-${String(idx + 1).padStart(3, "0")}`;
    }

    // Validate and default classification
    const validClassifications = ["observable", "requires-decomposition"];
    if (!validClassifications.includes(entry.classification)) {
      entry.classification = "observable"; // default
    }

    // Coerce booleans based on classification
    if (entry.classification === "observable") {
      entry.judgeable_directly = true;
      entry.requires_subcriteria = false;
    } else {
      entry.judgeable_directly = false;
      entry.requires_subcriteria = true;
    }

    return entry;
  });
}

/**
 * Count criteria by classification.
 */
function summarizeCriteria(entries) {
  const observable = entries.filter(e => e.classification === "observable").length;
  const decomposition = entries.filter(e => e.classification === "requires-decomposition").length;
  return { total: entries.length, observable, decomposition };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Validate required arguments
  if (!args.prd || !args.output) {
    console.log("err:missing required arguments: --prd and --output");
    process.exit(1);
  }

  // Check that PRD file exists
  if (!fs.existsSync(args.prd)) {
    console.log("err:prd file not found: " + args.prd);
    process.exit(1);
  }

  const model = args.model || "acceptance_extract";

  // Read PRD
  let prdContent;
  try {
    prdContent = fs.readFileSync(args.prd, "utf-8");
  } catch (e) {
    console.log("err:failed to read prd: " + e.message);
    process.exit(1);
  }

  // Read scope-corpus if provided
  let corpusContent = "";
  if (args.scopeCorpus) {
    try {
      if (fs.existsSync(args.scopeCorpus)) {
        corpusContent = fs.readFileSync(args.scopeCorpus, "utf-8");
      }
    } catch (e) {
      // Warn but continue
    }
  }

  // System prompt for acceptance criteria extraction
  const systemPrompt = `You are an acceptance-criteria extractor. Read the requirements and emit ONLY a single YAML document (no fences, no preamble) with one top-level key \`acceptance_criteria:\` — a list. Each entry must have:
- id: String like AC-001, AC-002, etc. (or omit to let the script assign)
- source: The REQ-ID or heading it came from (string)
- text: The criterion as a testable statement
- classification: Either "observable" (directly judgeable against a running product) or "requires-decomposition" (needs explicit sub-criteria)
- judgeable_directly: Boolean (true if observable, false otherwise)
- requires_subcriteria: Boolean (false if observable, true if requires-decomposition)

For "requires-decomposition" entries, also include:
- subcriteria: A list of concrete, individually-checkable statements

Example structure:
---
acceptance_criteria:
  - id: AC-001
    source: "REQ-001: User Authentication"
    text: "Users can log in with email and password"
    classification: "observable"
    judgeable_directly: true
    requires_subcriteria: false
  - id: AC-002
    source: "REQ-002: Admin Features"
    text: "Admin dashboard provides role-based access control"
    classification: "requires-decomposition"
    judgeable_directly: false
    requires_subcriteria: true
    subcriteria:
      - "Admin can assign roles to users"
      - "Users cannot see sections for roles they do not have"
      - "Role assignments persist across sessions"
...

Do not wrap the output in markdown fences. Return only valid YAML.`;

  // User message with PRD (+ corpus if provided)
  let userMessage = `PRD / Requirements Document:
${prdContent}`;

  if (corpusContent) {
    userMessage += `\n\n---\n\nScope Corpus (additional context):\n${corpusContent}`;
  }

  userMessage += `\n\n---\n\nNow extract and classify all acceptance criteria. Return only valid YAML with no markdown fences.`;

  // Call the model
  const result = await callModel(model, systemPrompt, userMessage);

  if (result.error) {
    console.log("err:model:" + result.error);
    process.exit(1);
  }

  // Parse the model response
  const responseText = stripFences(result.text);
  let parsed;
  try {
    parsed = yaml.load(responseText);
  } catch (e) {
    console.log("err:parse:" + e.message);
    process.exit(1);
  }

  // Validate that we have acceptance_criteria
  if (!parsed || !Array.isArray(parsed.acceptance_criteria)) {
    console.log("err:no_criteria");
    process.exit(1);
  }

  // Normalize entries
  const normalized = normalizeEntries(parsed.acceptance_criteria);

  // Write output
  const outDir = path.dirname(args.output);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const outputYaml = yaml.dump({ acceptance_criteria: normalized });
  fs.writeFileSync(args.output, outputYaml);

  // Success summary
  const summary = summarizeCriteria(normalized);
  console.log(`ok:${summary.total} criteria (${summary.observable} observable, ${summary.decomposition} requires-decomposition)`);
}

main().catch(e => {
  console.log("err:" + e.message);
  process.exit(1);
});
