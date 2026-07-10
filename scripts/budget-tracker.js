#!/usr/bin/env node
/**
 * budget-tracker.js — Infer and track autonomous-recovery iteration cap
 *
 * Infers the maximum number of recovery iterations for a build based on manifest
 * size and complexity, tracks how many have been used, and reports whether the cap
 * is reached.
 *
 * Usage:
 *   node scripts/budget-tracker.js \
 *     --manifest-dir <dir> \
 *     [--state <wiki/recovery-state.yaml>]   # recovery iterations log
 *     [--override N]                          # force max_recovery_iterations = N
 *     [--run-config <file>]                   # read run_config.recovery_iteration_cap_override
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// Constants
const ABSOLUTE_CAP = 15;
const INTEG_DATA_EVAL_AREAS = ["INTEG", "DATA", "EVAL"];

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--manifest-dir") {
      parsed.manifestDir = args[++i];
    } else if (args[i] === "--state") {
      parsed.state = args[++i];
    } else if (args[i] === "--override") {
      parsed.override = parseInt(args[++i], 10);
    } else if (args[i] === "--run-config") {
      parsed.runConfig = args[++i];
    }
  }
  return parsed;
}

/**
 * Count .yaml files in a directory
 */
function countYamlFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .length;
}

/**
 * Extract the area segment from a task_id (e.g., TASK-INTEG-0001 -> INTEG)
 */
function extractAreaFromTaskId(taskId) {
  const match = taskId.match(/^TASK-([A-Z]+)-\d+$/);
  return match ? match[1] : null;
}

/**
 * Load all tasks from manifest/tasks/ and compute complexity metrics
 */
function analyzeManifest(manifestDir) {
  const tasksDir = path.join(manifestDir, "tasks");
  const contractsDir = path.join(manifestDir, "contracts");

  const taskCount = countYamlFiles(tasksDir);
  const contractCount = countYamlFiles(contractsDir);

  // Load tasks to compute complexity metrics
  let integrDataEvalCount = 0;
  let totalDependsOnEdges = 0;
  let crossAreaDependsOnEdges = 0;

  if (fs.existsSync(tasksDir)) {
    const taskFiles = fs
      .readdirSync(tasksDir)
      .filter((f) => f.endsWith(".yaml"));

    for (const file of taskFiles) {
      const content = fs.readFileSync(path.join(tasksDir, file), "utf-8");
      let task;
      try {
        task = yaml.load(content);
      } catch {
        continue; // Skip unparseable files
      }

      if (!task || typeof task !== "object") continue;

      // Check if this task is in INTEG, DATA, or EVAL
      const taskId = task.task_id || file.replace(".yaml", "");
      const areaFromId = extractAreaFromTaskId(taskId);
      const functionalArea = task.functional_area
        ? task.functional_area.toUpperCase()
        : null;

      if (
        INTEG_DATA_EVAL_AREAS.includes(areaFromId) ||
        INTEG_DATA_EVAL_AREAS.includes(functionalArea)
      ) {
        integrDataEvalCount++;
      }

      // Count depends_on edges
      if (Array.isArray(task.depends_on)) {
        totalDependsOnEdges += task.depends_on.length;

        // Count cross-area dependencies
        for (const depId of task.depends_on) {
          const depArea = extractAreaFromTaskId(depId);
          if (depArea && depArea !== areaFromId) {
            crossAreaDependsOnEdges++;
          }
        }
      }
    }
  }

  // Compute proxies
  const integrDataEvalShare =
    taskCount > 0 ? integrDataEvalCount / taskCount : 0;
  const crossPackageDependencyDensity =
    totalDependsOnEdges > 0 ? crossAreaDependsOnEdges / totalDependsOnEdges : 0;

  return {
    taskCount,
    contractCount,
    integrDataEvalShare,
    crossPackageDependencyDensity,
  };
}

/**
 * Infer base recovery iterations based on task and contract counts
 */
function inferBase(taskCount, contractCount) {
  if (taskCount <= 50 && contractCount <= 5) {
    return 3; // small
  } else if (taskCount > 200 || contractCount > 20) {
    return 10; // large
  } else {
    return 5; // medium
  }
}

/**
 * Determine size category
 */
function getSizeCategory(taskCount, contractCount) {
  if (taskCount <= 50 && contractCount <= 5) {
    return "small";
  } else if (taskCount > 200 || contractCount > 20) {
    return "large";
  } else {
    return "medium";
  }
}

/**
 * Compute bonuses based on complexity metrics
 */
function computeBonuses(metrics) {
  let bonuses = 0;

  if (metrics.integrDataEvalShare > 0.3) {
    bonuses += 2;
  }

  if (metrics.crossPackageDependencyDensity > 0.5) {
    bonuses += 2;
  }

  if (metrics.taskCount > 500) {
    bonuses += 3;
  }

  return bonuses;
}

/**
 * Load recovery state and count used iterations
 */
function countUsedIterations(statePath) {
  if (!statePath || !fs.existsSync(statePath)) {
    return 0;
  }

  try {
    const content = fs.readFileSync(statePath, "utf-8");
    const data = yaml.load(content);

    if (Array.isArray(data)) {
      // Top-level list
      return data.length;
    } else if (data && Array.isArray(data.iterations)) {
      // {iterations: [...]}
      return data.iterations.length;
    }
  } catch {
    // Ignore parse errors
  }

  return 0;
}

/**
 * Load run_config override if present
 */
function loadRunConfigOverride(runConfigPath) {
  if (!runConfigPath || !fs.existsSync(runConfigPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(runConfigPath, "utf-8");
    const data = yaml.load(content);
    if (
      data &&
      data.run_config &&
      data.run_config.recovery_iteration_cap_override !== null &&
      data.run_config.recovery_iteration_cap_override !== undefined
    ) {
      return data.run_config.recovery_iteration_cap_override;
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Compute final cap, clamped to ABSOLUTE_CAP
 */
function computeCap(base, bonuses) {
  return Math.min(base + bonuses, ABSOLUTE_CAP);
}

function main() {
  const args = parseArgs();

  if (!args.manifestDir) {
    console.log("err:--manifest-dir required");
    process.exit(1);
  }

  // Analyze manifest
  const metrics = analyzeManifest(args.manifestDir);

  // Infer base and compute bonuses
  const base = inferBase(metrics.taskCount, metrics.contractCount);
  const bonuses = computeBonuses(metrics);
  const inferredCap = computeCap(base, bonuses);
  const size = getSizeCategory(metrics.taskCount, metrics.contractCount);

  // Apply overrides (highest precedence: --override, then run_config, then inferred)
  let cap = inferredCap;

  if (args.override !== undefined) {
    cap = computeCap(args.override, 0); // Clamp override to ABSOLUTE_CAP
  } else {
    const runConfigOverride = loadRunConfigOverride(args.runConfig);
    if (runConfigOverride !== null) {
      cap = computeCap(runConfigOverride, 0); // Clamp to ABSOLUTE_CAP
    }
  }

  // Count used iterations
  const used = countUsedIterations(args.state);
  const remaining = Math.max(0, cap - used);

  // Create wiki directory
  const wikiDir = path.join(args.manifestDir, "..", "wiki");
  fs.mkdirSync(wikiDir, { recursive: true });

  // Write budget report
  const report = {
    cap,
    used,
    remaining,
    base,
    bonuses,
    size,
    proxies: {
      integrDataEvalShare: metrics.integrDataEvalShare,
      crossPackageDependencyDensity: metrics.crossPackageDependencyDensity,
      taskCount: metrics.taskCount,
      contractCount: metrics.contractCount,
    },
  };

  const reportPath = path.join(wikiDir, "budget-report.yaml");
  fs.writeFileSync(reportPath, yaml.dump(report));

  // Output result
  if (used >= cap) {
    console.log(`halt:cap_reached:cap=${cap} used=${used}`);
    process.exit(0);
  } else {
    console.log(
      `ok:cap=${cap} used=${used} remaining=${remaining} base=${base} bonuses=${bonuses} size=${size}`
    );
    process.exit(0);
  }
}

main();
