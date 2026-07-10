#!/usr/bin/env node
/**
 * plan-preflight.js — Plan-phase contract completeness check
 *
 * Detects missing contract providers and unresolved symbol invocations
 * before manifest freeze, catching issues early.
 *
 * Usage:
 *   node scripts/plan-preflight.js --manifest-dir <dir> [--output <path>]
 *
 * Default output: <manifest-dir>/../wiki/plan-preflight-report.yaml
 *
 * Exit codes:
 *   0 = all checks passed (known gaps are not blocking)
 *   1 = blocking failures (unresolved contracts or symbols not covered by known_gap)
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// ─────────────────────────────────────────────────────────────────────────────
// Normalization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a symbol name per spec: strip HTTP verb prefix and arg list.
 * e.g. "POST /users" → "/users", "JobStore.list" → "JobStore.list"
 */
function bareSym(s) {
  if (typeof s !== "string") return s;
  const m = /^([A-Z]+\s+)?([A-Za-z_./][A-Za-z0-9_./]*)/.exec(s);
  return m && m[2] ? m[2] : s;
}

// Virtual (pseudo) contracts: consumed-only guidance with no contract file and
// no producer task (e.g. MODULE-PATHS-MANIFEST → manifest/module-paths.yaml,
// produced by a script, never a task — see references/manifest-schema.md).
// Keep in sync with VIRTUAL_CONTRACTS in manifest-validate.js.
const VIRTUAL_CONTRACTS = new Set(["MODULE-PATHS-MANIFEST"]);

/**
 * Load a YAML file and return the parsed object, or null on parse failure.
 */
function loadYAML(filePath) {
  try {
    return yaml.load(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return null;
  }
}

/**
 * Normalize contracts_consumed / contracts_produced arrays.
 * Accepts both legacy flat-string form and structured form.
 * Returns array of {contract_id, invokes: [], implements: []}
 */
function normalizeContractRefs(value) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => {
    if (typeof entry === "string") {
      // Legacy form: just the contract ID
      return {
        contract_id: entry,
        invokes: [],
        implements: [],
      };
    }
    if (entry && typeof entry === "object") {
      return {
        contract_id: entry.contract_id || entry.id || null,
        invokes: Array.isArray(entry.invokes) ? entry.invokes : [],
        implements: Array.isArray(entry.implements) ? entry.implements : [],
      };
    }
    return {
      contract_id: null,
      invokes: [],
      implements: [],
    };
  }).filter(r => r.contract_id);
}

/**
 * Get the set of all symbol names from a contract's surface definition.
 * Includes both full names and bare names (stripped of HTTP verbs, etc.)
 */
function contractSurfaceNames(contractDoc) {
  if (!contractDoc || !Array.isArray(contractDoc.surface)) return new Set();
  const names = new Set();
  for (const entry of contractDoc.surface) {
    if (entry && typeof entry === "object" && typeof entry.name === "string") {
      const full = entry.name;
      const bare = bareSym(full);
      names.add(full);
      if (bare !== full) names.add(bare);
    }
  }
  return names;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    manifestDir: null,
    output: null,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir":
        parsed.manifestDir = args[++i];
        break;
      case "--output":
        parsed.output = args[++i];
        break;
    }
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main logic
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs();

  if (!opts.manifestDir) {
    console.error("err:missing --manifest-dir");
    process.exit(1);
  }

  // Compute default output path if not provided
  let outputPath = opts.output;
  if (!outputPath) {
    const parent = path.dirname(opts.manifestDir);
    outputPath = path.join(parent, "wiki", "plan-preflight-report.yaml");
  }

  // Load all task and contract files
  const tasksDir = path.join(opts.manifestDir, "tasks");
  const contractsDir = path.join(opts.manifestDir, "contracts");

  const tasks = {};
  const contracts = {};
  const parseErrors = [];

  // Load tasks
  if (fs.existsSync(tasksDir)) {
    for (const file of fs.readdirSync(tasksDir)) {
      if (!file.endsWith(".yaml")) continue;
      const filePath = path.join(tasksDir, file);
      const doc = loadYAML(filePath);
      if (doc === null) {
        parseErrors.push(file);
        continue;
      }
      if (doc.task_id) {
        tasks[doc.task_id] = doc;
      }
    }
  }

  // Load contracts
  if (fs.existsSync(contractsDir)) {
    for (const file of fs.readdirSync(contractsDir)) {
      if (!file.endsWith(".yaml")) continue;
      const filePath = path.join(contractsDir, file);
      const doc = loadYAML(filePath);
      if (doc === null) {
        parseErrors.push(file);
        continue;
      }
      if (doc.contract_id) {
        contracts[doc.contract_id] = doc;
      }
    }
  }

  // Analyze contracts across all tasks
  const allConsumedContracts = new Set();
  const allProducedContracts = new Set();
  const consumersMap = {}; // contract_id -> [{ taskId, invokes: [] }]
  const producersMap = {}; // contract_id -> [{ taskId, implements: [] }]

  for (const [taskId, taskDoc] of Object.entries(tasks)) {
    const consumed = normalizeContractRefs(taskDoc.contracts_consumed);
    const produced = normalizeContractRefs(taskDoc.contracts_produced);

    for (const ref of consumed) {
      allConsumedContracts.add(ref.contract_id);
      if (!consumersMap[ref.contract_id]) {
        consumersMap[ref.contract_id] = [];
      }
      consumersMap[ref.contract_id].push({
        taskId,
        invokes: ref.invokes,
      });
    }

    for (const ref of produced) {
      allProducedContracts.add(ref.contract_id);
      if (!producersMap[ref.contract_id]) {
        producersMap[ref.contract_id] = [];
      }
      producersMap[ref.contract_id].push({
        taskId,
        implements: ref.implements,
      });
    }
  }

  // Collect findings
  const unresolvedFindings = [];
  const knownGapFindings = [];

  // 1. Check for unresolved contracts (no producer)
  for (const contractId of allConsumedContracts) {
    // Virtual contracts are produced by scripts, never tasks — exempt
    // (mirrors manifest-validate.js Gate 3).
    if (VIRTUAL_CONTRACTS.has(contractId)) continue;
    if (!allProducedContracts.has(contractId)) {
      const consumers = consumersMap[contractId] || [];
      for (const consumer of consumers) {
        const taskDoc = tasks[consumer.taskId];
        const isKnownGap = taskDoc && taskDoc.known_gap === true;

        const finding = {
          contract_id: contractId,
          symbol: null,
          consumer_task: consumer.taskId,
          kind: "contract",
        };

        if (isKnownGap) {
          finding.reason = taskDoc.known_gap_reason || "known gap";
          knownGapFindings.push(finding);
        } else {
          unresolvedFindings.push(finding);
        }
      }
    }
  }

  // 2. Check for unresolved symbols (invoked but not implemented)
  for (const contractId of allConsumedContracts) {
    const consumers = consumersMap[contractId] || [];
    const producers = producersMap[contractId] || [];

    // Only check symbols if there's at least one producer
    if (producers.length === 0) {
      // Already caught as unresolved_contract above
      continue;
    }

    // Build set of all implemented symbols across all producers of this contract
    const implementedSymbols = new Set();
    for (const producer of producers) {
      for (const sym of producer.implements) {
        implementedSymbols.add(bareSym(sym));
      }
    }

    // Check each consumer's invokes
    for (const consumer of consumers) {
      for (const invoked of consumer.invokes) {
        const bareInvoked = bareSym(invoked);
        if (!implementedSymbols.has(bareInvoked)) {
          const taskDoc = tasks[consumer.taskId];
          const isKnownGap = taskDoc && taskDoc.known_gap === true;

          const finding = {
            contract_id: contractId,
            symbol: bareInvoked,
            consumer_task: consumer.taskId,
            kind: "symbol",
          };

          if (isKnownGap) {
            finding.reason = taskDoc.known_gap_reason || "known gap";
            knownGapFindings.push(finding);
          } else {
            unresolvedFindings.push(finding);
          }
        }
      }
    }
  }

  // Build report
  const report = {
    summary: {
      tasks: Object.keys(tasks).length,
      contracts: Object.keys(contracts).length,
      consumed_contracts: allConsumedContracts.size,
      produced_contracts: allProducedContracts.size,
      unresolved_contracts: unresolvedFindings.filter(f => f.kind === "contract").length,
      unresolved_symbols: unresolvedFindings.filter(f => f.kind === "symbol").length,
      known_gaps: knownGapFindings.length,
      parse_errors: parseErrors.length,
    },
    unresolved: unresolvedFindings,
    known_gaps: knownGapFindings,
    parse_errors: parseErrors,
  };

  // Write report
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, yaml.dump(report, { lineWidth: -1 }));

  // Determine exit status
  if (unresolvedFindings.length > 0) {
    const numContracts = unresolvedFindings.filter(f => f.kind === "contract").length;
    const numSymbols = unresolvedFindings.filter(f => f.kind === "symbol").length;
    console.log(`err:plan_preflight:${unresolvedFindings.length} unresolved (${numContracts} contracts, ${numSymbols} symbols), ${knownGapFindings.length} known gaps`);
    process.exit(1);
  }

  const numProducers = Object.keys(producersMap).length;
  const numConsumers = Object.keys(consumersMap).length;
  console.log(`ok:preflight clean (${knownGapFindings.length} known gaps, ${numProducers} producers, ${numConsumers} consumers)`);
}

main();
