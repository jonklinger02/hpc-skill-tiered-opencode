#!/usr/bin/env node
/**
 * acceptance-run.js — Phase 5 acceptance harness
 *
 * Validate the built product against PRD intent. For each acceptance criterion,
 * an Opus judge investigates the RUNNING app and returns a strict pass/fail.
 * All must pass. Any fail routes to M5 recovery.
 *
 * Usage:
 *   node scripts/acceptance-run.js \
 *     --criteria <manifest/acceptance-criteria.yaml> \
 *     --app-url <http://localhost:3000> \
 *     --code-dir <project root> \
 *     [--logs <app log file>] \
 *     [--output <ACCEPTANCE-REPORT.md>] \
 *     [--wiki-dir <wiki/>] \
 *     [--judge-model claude-opus-4-6]
 *
 * Returns "ok:<summary>" or "err:<description>"
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { resolveModel } = require("./lib/models.js");
const { callAgent } = require("./lib/opencode-client");

// ── Argument Parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--criteria":      parsed.criteria = args[++i]; break;
      case "--app-url":       parsed.appUrl = args[++i]; break;
      case "--code-dir":      parsed.codeDir = args[++i]; break;
      case "--logs":          parsed.logs = args[++i]; break;
      case "--output":        parsed.output = args[++i]; break;
      case "--wiki-dir":      parsed.wikiDir = args[++i]; break;
      case "--judge-model":   parsed.judgeModel = args[++i]; break;
    }
  }
  return parsed;
}

// ── Judge Call Helper ─────────────────────────────────────────────────────

async function callJudge(model, systemPrompt, userMessage, criterionId) {
  // Offline/test stub: read a canned verdict per criterion id from a dir.
  if (process.env.HPC_JUDGE_STUB_DIR) {
    const f = path.join(process.env.HPC_JUDGE_STUB_DIR, `${criterionId}.txt`);
    try { return { text: fs.readFileSync(f, "utf-8") }; }
    catch { return { text: "fail:no stub verdict for " + criterionId }; }
  }
  return callAgent({
    role: "acceptance_judge",
    model: resolveModel(model),
    systemPrompt,
    userMessage,
    timeoutMs: 1500000,
    tools: { read: true, list: true, glob: true, grep: true, edit: false, bash: false },
    effort: null,
  });
}

// ── System Prompt (Fixed) ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a strict acceptance judge. Your verdict is pass or fail. No middle ground. Stubs that raise NotImplementedError fail. Functions that return placeholder values fail. The criterion is satisfied only if the running product observably demonstrates it. You may NOT pass based on code inspection alone if the criterion describes runtime behavior. You have read-only tool access (Bash for curl/playwright/log reads, Read for files); do not write outside /tmp. Emit exactly one final line: \`pass:<evidence>\` (with at least one curl response, log excerpt, or screenshot reference) or \`fail:<specific cited reason>\`.`;

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Ensure a directory exists, creating if needed.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build the user message for the judge, including criterion text, classification,
 * app URL, and code-dir path. For requires-decomposition criteria with subcriteria,
 * instruct the judge to evaluate each sub-criterion individually.
 */
function buildJudgeMessage(criterion, appUrl, codeDir, logs) {
  let msg = `Criterion ID: ${criterion.id}\n`;
  msg += `Criterion Text: ${criterion.text}\n`;
  msg += `Classification: ${criterion.classification}\n`;
  msg += `Source: ${criterion.source || "not specified"}\n`;
  msg += `Application URL: ${appUrl}\n`;
  msg += `Code Directory: ${codeDir}\n`;

  if (logs) {
    msg += `Application Log File: ${logs}\n`;
  }

  if (criterion.classification === "requires-decomposition" && criterion.subcriteria && Array.isArray(criterion.subcriteria)) {
    msg += `\nThis criterion requires decomposition. Evaluate each of these sub-criteria individually:\n`;
    for (let i = 0; i < criterion.subcriteria.length; i++) {
      msg += `${i + 1}. ${criterion.subcriteria[i]}\n`;
    }
    msg += `\nPass the parent criterion ONLY if ALL sub-criteria pass. If any sub-criterion fails, cite which one and why.\n`;
  }

  msg += `\nInvestigate the running application at the provided URL and determine whether it satisfies this criterion.`;

  return msg;
}

/**
 * Parse the last line matching `^(pass|fail):` from text.
 * Returns { verdict: "pass"|"fail", evidence: string } or null if not found.
 */
function parseVerdictLine(text) {
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("pass:")) {
      return { verdict: "pass", evidence: line.substring(5).trim() };
    }
    if (line.startsWith("fail:")) {
      return { verdict: "fail", reason: line.substring(5).trim() };
    }
  }
  return null;
}

/**
 * Generate a markdown report section for a single criterion.
 */
function renderCriterionSection(criterion, result) {
  let section = `### ${criterion.id}: ${criterion.text}\n`;
  section += `**Source:** ${criterion.source || "not specified"}\n`;
  section += `**Classification:** ${criterion.classification}\n`;
  section += `**Verdict:** ${result.verdict}\n`;

  if (result.verdict === "pass") {
    section += `**Evidence:** ${result.evidence}\n`;
  } else {
    section += `**Failure Reason:** ${result.reason || "unparseable verdict from judge"}\n`;
  }

  return section;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Validate required arguments
  if (!args.criteria || !args.appUrl || !args.codeDir) {
    console.log("err:missing required arguments: --criteria, --app-url, --code-dir");
    process.exit(1);
  }

  // Check that criteria file exists
  if (!fs.existsSync(args.criteria)) {
    console.log("err:criteria file not found: " + args.criteria);
    process.exit(1);
  }

  // Set defaults for optional arguments
  const outputFile = args.output || "./ACCEPTANCE-REPORT.md";
  const outputDir = path.dirname(path.resolve(outputFile));
  const wikiDir = args.wikiDir || path.join(outputDir, "wiki");
  const judgeModel = args.judgeModel || "acceptance_judge";

  // Ensure wiki/acceptance directory exists
  ensureDir(path.join(wikiDir, "acceptance"));

  // Load criteria
  let criteriaContent;
  try {
    criteriaContent = fs.readFileSync(args.criteria, "utf-8");
  } catch (e) {
    console.log("err:failed to read criteria file: " + e.message);
    process.exit(1);
  }

  let criteriaData;
  try {
    criteriaData = yaml.load(criteriaContent);
  } catch (e) {
    console.log("err:failed to parse criteria YAML: " + e.message);
    process.exit(1);
  }

  if (!criteriaData || !Array.isArray(criteriaData.acceptance_criteria)) {
    console.log("err:criteria file does not have acceptance_criteria array");
    process.exit(1);
  }

  const criteria = criteriaData.acceptance_criteria;

  // Dispatch judge per criterion (sequential)
  const results = [];
  for (const criterion of criteria) {
    const userMessage = buildJudgeMessage(criterion, args.appUrl, args.codeDir, args.logs);
    const result = await callJudge(judgeModel, SYSTEM_PROMPT, userMessage, criterion.id);

    let verdict = "fail";
    let evidence = null;
    let reason = null;

    if (result.error) {
      reason = `judge_error: ${result.error}`;
    } else {
      const parsed = parseVerdictLine(result.text);
      if (parsed) {
        verdict = parsed.verdict;
        if (verdict === "pass") {
          evidence = parsed.evidence;
        } else {
          reason = parsed.reason;
        }
      } else {
        reason = "unparseable_verdict";
      }
    }

    results.push({
      id: criterion.id,
      text: criterion.text,
      source: criterion.source,
      classification: criterion.classification,
      verdict,
      evidence,
      reason,
      rawOutput: result.text || result.error
    });

    // Write per-criterion evidence file
    const evidenceFile = path.join(wikiDir, "acceptance", `${criterion.id}.txt`);
    fs.writeFileSync(evidenceFile, result.text || result.error, "utf-8");
  }

  // Aggregate results
  const passCount = results.filter(r => r.verdict === "pass").length;
  const failCount = results.filter(r => r.verdict === "fail").length;
  const allPass = failCount === 0;

  // Build report markdown
  let report = `# Acceptance Report — ${path.basename(args.codeDir)}\n\n`;
  report += `**Tested at:** ${new Date().toISOString()}\n`;
  report += `**Application URL:** ${args.appUrl}\n`;
  report += `**Verdict:** ${allPass ? "PASS" : "FAIL"}\n\n`;

  report += `## Summary\n`;
  report += `- Criteria evaluated: ${criteria.length}\n`;
  report += `- Passed: ${passCount}\n`;
  report += `- Failed: ${failCount}\n\n`;

  report += `## Per-criterion results\n`;
  for (const result of results) {
    report += renderCriterionSection(
      { id: result.id, text: result.text, source: result.source, classification: result.classification },
      result
    );
    report += "\n";
  }

  // Write report
  ensureDir(outputDir);
  fs.writeFileSync(path.resolve(outputFile), report, "utf-8");

  // Print result
  if (allPass) {
    console.log(`ok:acceptance PASS criteria=${criteria.length} report=${path.resolve(outputFile)}`);
  } else {
    console.log(`err:acceptance:${failCount} failed report=${path.resolve(outputFile)}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.log("err:" + e.message);
  process.exit(1);
});
