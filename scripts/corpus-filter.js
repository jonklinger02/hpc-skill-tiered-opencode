#!/usr/bin/env node
/**
 * corpus-filter.js — Reads the input corpus and build target, asks a Sonnet
 * sub-agent to classify what is in-scope for THIS build vs intentionally deferred,
 * and writes two artifacts: scope-corpus.md and deferred-scope.yaml.
 *
 * Usage:
 *   node corpus-filter.js \
 *     --input-docs <dir> \
 *     --build-target <str-or-@file> \
 *     --output-corpus <path> \
 *     --output-deferred <path> \
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
      case "--input-docs":      parsed.inputDocs = args[++i]; break;
      case "--build-target":    parsed.buildTarget = args[++i]; break;
      case "--output-corpus":   parsed.outputCorpus = args[++i]; break;
      case "--output-deferred": parsed.outputDeferred = args[++i]; break;
      case "--model":           parsed.model = args[++i]; break;
    }
  }
  return parsed;
}

/**
 * Read all text files in a directory (.md, .yaml, .txt, .json)
 * and prepend filename headers for context.
 */
function readInputDocs(dir) {
  if (!dir || !fs.existsSync(dir)) return "";

  const exts = new Set([".md", ".yaml", ".yml", ".txt", ".json"]);
  const files = fs.readdirSync(dir)
    .filter(f => exts.has(path.extname(f).toLowerCase()))
    .sort();

  const parts = [];
  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      parts.push(`\n## File: ${file}\n${content}`);
    } catch (e) {
      // Skip unreadable files
    }
  }

  return parts.join("\n");
}

/**
 * Resolve build target: if it starts with '@', read the rest as a file path;
 * otherwise return the string as-is.
 */
function resolveBuildTarget(buildTarget) {
  if (!buildTarget) return "";
  if (buildTarget.startsWith("@")) {
    const filePath = buildTarget.slice(1);
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch (e) {
      throw new Error(`failed to read build target file ${filePath}: ${e.message}`);
    }
  }
  return buildTarget;
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
    role: "corpus_filter",
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Validate required arguments
  if (!args.inputDocs || !args.buildTarget || !args.outputCorpus || !args.outputDeferred) {
    console.log("err:missing required arguments: --input-docs, --build-target, --output-corpus, --output-deferred");
    process.exit(1);
  }

  const model = args.model || "corpus_filter";

  // Read input corpus
  const corpusText = readInputDocs(args.inputDocs);
  if (!corpusText.trim()) {
    console.log("err:no input docs found in " + args.inputDocs);
    process.exit(1);
  }

  // Resolve build target
  let buildTarget;
  try {
    buildTarget = resolveBuildTarget(args.buildTarget);
  } catch (e) {
    console.log("err:" + e.message);
    process.exit(1);
  }

  if (!buildTarget.trim()) {
    console.log("err:empty build target");
    process.exit(1);
  }

  // System prompt for the scope classifier
  const systemPrompt = `You are a scope classifier for software builds. Your task is to read a corpus of input documents (PRD, specification, design docs, test plans) and a build target description, then classify each major section/feature as either:

1. IN-SCOPE: This build will address this requirement directly.
2. DEFERRED: This is intentionally deferred to a future build, and has a clear dependency or rationale.

You must return ONLY a valid YAML document with NO markdown fences, NO preamble, and NO explanatory text.

The YAML document MUST have exactly these two top-level keys:
- scope_corpus: A YAML block scalar (|) containing markdown text describing what THIS build addresses. This should be a synthesized summary of the in-scope requirements.
- deferred_scope: A list of deferred items (or an empty list []). Each item has:
  - id: String like "DEFERRED-001", "DEFERRED-002", etc.
  - corpus_sections: List of strings naming the source document sections this defers.
  - summary: One-sentence summary of what is deferred.
  - rationale: Why this is deferred (e.g., "depends on auth system", "lower priority").
  - depends_on_current_build: List of strings naming outputs/capabilities from the current build that this future item will depend on.
  - suggested_future_epic: Name of a future epic or milestone that should contain this.
  - rough_task_estimate: Integer, rough story points (1-13).

Example YAML structure:
---
scope_corpus: |
  # Build 1: Core API & Auth

  This build delivers:
  - REST API endpoints for users, posts, comments
  - Email/password authentication
  - Admin dashboard

deferred_scope:
  - id: DEFERRED-001
    corpus_sections: ["Real-time notifications", "WebSocket section"]
    summary: Real-time notifications via WebSocket.
    rationale: Depends on stable API and user base.
    depends_on_current_build: ["REST API", "Auth system"]
    suggested_future_epic: "Build 2: Real-time Features"
    rough_task_estimate: 8
  - id: DEFERRED-002
    corpus_sections: ["Analytics"]
    summary: Analytics dashboard and reporting.
    rationale: Lower priority, can be added after core features proven.
    depends_on_current_build: ["REST API", "Admin dashboard"]
    suggested_future_epic: "Build 3: Analytics & Insights"
    rough_task_estimate: 5
...

Do not wrap the output in markdown fences. Return only the YAML.`;

  // User message with corpus and build target
  const userMessage = `
INPUT CORPUS (all available documents):
${corpusText}

---

BUILD TARGET (what this specific build should deliver):
${buildTarget}

---

Now classify the corpus sections as in-scope or deferred for this build. Return only valid YAML with no markdown fences.
`;

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

  // Validate that we have scope_corpus
  if (!parsed || typeof parsed.scope_corpus !== "string") {
    console.log("err:missing_scope_corpus");
    process.exit(1);
  }

  // Write output-corpus
  const outCorpusDir = path.dirname(args.outputCorpus);
  if (outCorpusDir) fs.mkdirSync(outCorpusDir, { recursive: true });
  fs.writeFileSync(args.outputCorpus, parsed.scope_corpus);

  // Write output-deferred
  const deferredList = parsed.deferred_scope || [];
  const deferredYaml = yaml.dump({ deferred_scope: deferredList });
  const outDeferredDir = path.dirname(args.outputDeferred);
  if (outDeferredDir) fs.mkdirSync(outDeferredDir, { recursive: true });
  fs.writeFileSync(args.outputDeferred, deferredYaml);

  // Success
  const summary = `scope-corpus written, ${deferredList.length} deferred entries`;
  console.log("ok:" + summary);
}

main().catch(e => {
  console.log("err:" + e.message);
  process.exit(1);
});
