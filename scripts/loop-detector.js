#!/usr/bin/env node
/**
 * loop-detector.js — Detect non-converging recovery loops
 *
 * Reads a recovery-iteration log and applies three detectors to identify if the
 * system is stuck in a non-converging loop. Returns a verdict that the recovery
 * driver acts on: continue, escalate, or halt.
 *
 * Usage:
 *   node scripts/loop-detector.js \
 *     --state <wiki/recovery-state.yaml> \
 *     [--report <wiki/loop-detector-report.yaml>]
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--state") {
      parsed.state = args[++i];
    } else if (args[i] === "--report") {
      parsed.report = args[++i];
    }
  }
  return parsed;
}

/**
 * Load recovery state from YAML file.
 * Accepts either {iterations: [...]} or a bare top-level list.
 * Returns {iterations: [...]}.
 */
function loadRecoveryState(statePath) {
  if (!fs.existsSync(statePath)) {
    return { iterations: [] };
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    const data = yaml.load(content);

    if (Array.isArray(data)) {
      // Top-level list
      return { iterations: data };
    } else if (data && Array.isArray(data.iterations)) {
      // {iterations: [...]}
      return data;
    }
  } catch {
    // Ignore parse errors; return empty state
  }

  return { iterations: [] };
}

/**
 * Detector 1: signature-stable
 * The two MOST RECENT iterations target the SAME slice AND have identical
 * task_signature_hash. The task converged on a wrong answer (same output/failure twice).
 *
 * Verdict: escalate
 */
function detectSignatureStable(iterations) {
  if (iterations.length < 2) {
    return null;
  }

  const last = iterations[iterations.length - 1];
  const secondLast = iterations[iterations.length - 2];

  if (
    last.slice === secondLast.slice &&
    last.task_signature_hash === secondLast.task_signature_hash
  ) {
    return {
      name: "signature-stable",
      verdict: "escalate",
      reason: `same slice (${last.slice}) with same task_signature_hash (${last.task_signature_hash}) in last 2 iterations`,
    };
  }

  return null;
}

/**
 * Detector 2: slice-stable
 * The THREE most recent iterations all target the SAME slice and none has
 * outcome: resolved. Three iterations on one slice without resolving it.
 *
 * Verdict: escalate
 */
function detectSliceStable(iterations) {
  if (iterations.length < 3) {
    return null;
  }

  const last = iterations[iterations.length - 1];
  const secondLast = iterations[iterations.length - 2];
  const thirdLast = iterations[iterations.length - 3];

  if (last.slice === secondLast.slice && secondLast.slice === thirdLast.slice) {
    // Check if any has outcome: resolved
    if (
      last.outcome !== "resolved" &&
      secondLast.outcome !== "resolved" &&
      thirdLast.outcome !== "resolved"
    ) {
      return {
        name: "slice-stable",
        verdict: "escalate",
        reason: `same slice (${last.slice}) in last 3 iterations, all unresolved`,
      };
    }
  }

  return null;
}

/**
 * Detector 3: manifest-cycle
 * Iteration N's manifest_hash equals iteration N-2's manifest_hash.
 * The system is oscillating between two manifest states.
 * Requires ≥3 iterations.
 *
 * Verdict: halt
 */
function detectManifestCycle(iterations) {
  if (iterations.length < 3) {
    return null;
  }

  // Check if any iteration i's manifest_hash == iteration i-2's manifest_hash.
  // Only a true A→B→A oscillation counts: all three hashes must be present and
  // the middle hash must differ. Unchanged or absent hashes are expected on the
  // escalation ladder (deliberate-fork.js records 'escalated_no_amendment' /
  // 'escalated_diffguard' BEFORE any manifest amendment) and must not halt.
  for (let i = 2; i < iterations.length; i++) {
    const a = iterations[i - 2].manifest_hash;
    const b = iterations[i - 1].manifest_hash;
    const c = iterations[i].manifest_hash;
    if (a && b && c && c === a && b !== c) {
      return {
        name: "manifest-cycle",
        verdict: "halt",
        reason: `manifest_hash oscillation detected: iter ${i - 2} and iter ${i} both have ${iterations[i].manifest_hash}`,
      };
    }
  }

  return null;
}

/**
 * Apply all detectors and determine final verdict.
 * Precedence: manifest-cycle (halt) > signature-stable OR slice-stable (escalate) > continue
 */
function detectLoops(iterations) {
  // Apply detectors in precedence order
  const manifestCycle = detectManifestCycle(iterations);
  if (manifestCycle) {
    return {
      verdict: "halt",
      firedDetectors: ["manifest-cycle"],
      detector: "manifest-cycle",
      reason: manifestCycle.reason,
    };
  }

  const signatureStable = detectSignatureStable(iterations);
  const sliceStable = detectSliceStable(iterations);

  const fired = [];
  if (signatureStable) fired.push("signature-stable");
  if (sliceStable) fired.push("slice-stable");

  if (fired.length > 0) {
    const detector = fired.length === 2 ? "signature-stable,slice-stable" : fired[0];
    const reason = [signatureStable?.reason, sliceStable?.reason]
      .filter(Boolean)
      .join("; ");
    return {
      verdict: "escalate",
      firedDetectors: fired,
      detector,
      reason,
    };
  }

  // No detectors fired
  return {
    verdict: "continue",
    firedDetectors: [],
    detector: "none",
    reason: "no loops detected",
  };
}

/**
 * Build a report YAML object with key metadata
 */
function buildReport(verdict, firedDetectors, iterations) {
  const lastFewIterations = iterations.slice(-3).map((it) => ({
    iteration: it.iteration,
    slice: it.slice,
    task_signature_hash: it.task_signature_hash,
    manifest_hash: it.manifest_hash,
    outcome: it.outcome,
  }));

  return {
    verdict,
    fired_detectors: firedDetectors,
    iteration_count: iterations.length,
    last_iterations: lastFewIterations,
  };
}

function main() {
  const args = parseArgs();

  if (!args.state) {
    console.log("verdict:continue:none:no state file provided");
    process.exit(0);
  }

  // Load recovery state
  const state = loadRecoveryState(args.state);
  const iterations = state.iterations || [];

  if (!iterations || iterations.length === 0) {
    console.log("verdict:continue:none:no iterations yet");

    // Write report even for zero iterations
    const stateDir = path.dirname(args.state);
    const reportPath = args.report || path.join(stateDir, "loop-detector-report.yaml");
    const report = buildReport("continue", [], []);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, yaml.dump(report));

    process.exit(0);
  }

  // Detect loops
  const detection = detectLoops(iterations);

  // Build output line
  const output = `verdict:${detection.verdict}:${detection.detector}:${detection.reason}`;
  console.log(output);

  // Write report
  const stateDir = path.dirname(args.state);
  const reportPath = args.report || path.join(stateDir, "loop-detector-report.yaml");
  const report = buildReport(detection.verdict, detection.firedDetectors, iterations);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, yaml.dump(report));

  process.exit(0);
}

main();
