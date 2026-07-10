#!/usr/bin/env node
/**
 * dag.js — DAG computation and topological sorting
 * 
 * Usage:
 *   node dag.js --manifest-dir <dir> --check-cycles    # Verify acyclicity
 *   node dag.js --manifest-dir <dir> --topo-sort        # Output topological order
 *   node dag.js --manifest-dir <dir> --next-batch <state.json>  # Get next parallel batch
 *   node dag.js --manifest-dir <dir> --critical-junctions  # Find critical DAG junctions
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--check-cycles": parsed.action = "check-cycles"; break;
      case "--topo-sort": parsed.action = "topo-sort"; break;
      case "--next-batch": parsed.action = "next-batch"; parsed.stateFile = args[++i]; break;
      case "--critical-junctions": parsed.action = "critical-junctions"; break;
      case "--blockage-report": parsed.action = "blockage-report"; parsed.stateFile = args[++i]; break;
      case "--cascade-block":
        parsed.action = "cascade-block";
        parsed.stateFile = args[++i];
        parsed.taskId = args[++i];
        break;
      case "--ancestors":
        parsed.action = "ancestors";
        parsed.taskId = args[++i];
        break;
      case "--descendants":
        parsed.action = "descendants";
        parsed.taskId = args[++i];
        break;
      case "--level": parsed.level = args[++i]; break; // epic, group, task
    }
  }
  return parsed;
}

// Read all YAML files matching a pattern and extract IDs and depends_on
function loadArtifacts(dir, pattern) {
  const artifacts = [];
  if (!fs.existsSync(dir)) return artifacts;
  
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".yaml")) continue;
    const content = fs.readFileSync(path.join(dir, f), "utf-8");
    
    // Simple YAML parsing for id and depends_on fields
    const idMatch = content.match(/^(?:epic_id|group_id|task_id):\s*"?([^"\n]+)"?/m);

    if (idMatch) {
      const id = idMatch[1].trim();
      const deps = [];
      // Inline form first: depends_on: ["TASK-A", "TASK-B"] — a council output
      // format (mirrors execute.js extractListField). `depends_on: []` → [].
      const inlineMatch = content.match(/^depends_on:\s*\[([^\]]*)\]/m);
      if (inlineMatch) {
        for (const part of inlineMatch[1].split(",")) {
          const dep = part.trim().replace(/^["']|["']$/g, "").trim();
          if (dep) deps.push(dep);
        }
      } else {
        // Block form; tolerate a final list item without a trailing newline.
        const depsMatch = content.match(/^depends_on:\s*\n((?:\s+-\s*.+\n?)*)/m);
        if (depsMatch) {
          const depLines = depsMatch[1].match(/^\s+-\s*"?([^"\n]+)"?/gm);
          if (depLines) {
            for (const line of depLines) {
              const m = line.match(/^\s+-\s*"?([^"\n]+)"?/);
              if (m) deps.push(m[1].trim());
            }
          }
        }
      }
      artifacts.push({ id, depends_on: deps, file: f });
    }
  }
  return artifacts;
}

// Build adjacency list from artifacts
function buildGraph(artifacts) {
  const graph = {}; // id -> [dependency ids]
  const reverse = {}; // id -> [dependent ids]
  const allIds = new Set();
  
  for (const a of artifacts) {
    allIds.add(a.id);
    graph[a.id] = a.depends_on || [];
    if (!reverse[a.id]) reverse[a.id] = [];
    for (const dep of a.depends_on || []) {
      if (!reverse[dep]) reverse[dep] = [];
      reverse[dep].push(a.id);
    }
  }
  
  return { graph, reverse, allIds };
}

// Detect cycles using DFS
function detectCycles(graph, allIds) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {};
  const cycles = [];
  const parent = {};
  
  for (const id of allIds) color[id] = WHITE;
  
  function dfs(u, path) {
    color[u] = GRAY;
    path.push(u);
    
    for (const v of (graph[u] || [])) {
      if (!allIds.has(v)) continue; // Skip references to unknown nodes
      if (color[v] === GRAY) {
        // Found cycle
        const cycleStart = path.indexOf(v);
        cycles.push(path.slice(cycleStart).concat(v));
      } else if (color[v] === WHITE) {
        dfs(v, [...path]);
      }
    }
    
    color[u] = BLACK;
  }
  
  for (const id of allIds) {
    if (color[id] === WHITE) dfs(id, []);
  }
  
  return cycles;
}

// Topological sort using Kahn's algorithm
function topoSort(graph, allIds) {
  const inDegree = {};
  for (const id of allIds) inDegree[id] = 0;
  
  for (const id of allIds) {
    for (const dep of (graph[id] || [])) {
      if (allIds.has(dep)) {
        // dep -> id means id depends on dep, so inDegree of id increases
        // Actually: graph[id] = dependencies of id, so dep is a predecessor
      }
    }
  }
  
  // Recalculate: for each node, count how many nodes depend on it
  // graph[id] = [nodes that id depends on] = predecessors
  // We want: for each node, how many have it as a predecessor
  for (const id of allIds) inDegree[id] = 0;
  for (const id of allIds) {
    for (const dep of (graph[id] || [])) {
      if (allIds.has(id)) {
        // id depends on dep, so in the execution order dep comes first
        // inDegree[id]++ because id has an incoming edge from dep
        inDegree[id] = (inDegree[id] || 0) + 1;
      }
    }
  }
  // Fix: recount properly
  for (const id of allIds) inDegree[id] = 0;
  for (const id of allIds) {
    for (const dep of (graph[id] || [])) {
      if (allIds.has(dep)) {
        inDegree[id]++;
      }
    }
  }
  
  const queue = [];
  for (const id of allIds) {
    if (inDegree[id] === 0) queue.push(id);
  }
  
  const sorted = [];
  while (queue.length > 0) {
    const u = queue.shift();
    sorted.push(u);
    
    // Find all nodes that depend on u
    for (const id of allIds) {
      if ((graph[id] || []).includes(u)) {
        inDegree[id]--;
        if (inDegree[id] === 0) queue.push(id);
      }
    }
  }
  
  if (sorted.length !== allIds.size) {
    return { sorted: null, error: "Cycle detected — cannot topologically sort" };
  }
  
  return { sorted, error: null };
}

// Get next executable batch given current state.
// A task is eligible only if every predecessor is COMPLETE — predecessors in
// PLANNED/IN_PROGRESS/LOCKED/ESCALATED/BLOCKED all leave the task ineligible.
function getNextBatch(graph, allIds, stateFile) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const tasks = state.tasks || {};

  const eligible = [];
  for (const id of allIds) {
    if (!tasks[id] || tasks[id].status !== "PLANNED") continue;

    // Check all predecessors are COMPLETE
    const deps = graph[id] || [];
    const allDepsComplete = deps.every(dep => {
      if (!allIds.has(dep)) return true; // Unknown dep, skip
      return tasks[dep] && tasks[dep].status === "COMPLETE";
    });

    if (allDepsComplete) eligible.push(id);
  }

  return eligible;
}

// BFS the reverse graph from <taskId> and return all transitive dependents
// currently in PLANNED / IN_PROGRESS / LOCKED. Skips COMPLETE (already done),
// BLOCKED (already in a fork), and ESCALATED (legacy manual marker).
// Read-only: does not mutate state.
function cascadeBlock(reverse, allIds, stateFile, taskId) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const tasks = state.tasks || {};

  const result = [];
  const visited = new Set([taskId]);
  const queue = [taskId];

  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of (reverse[cur] || [])) {
      if (visited.has(next)) continue;
      visited.add(next);
      const t = tasks[next];
      if (!t) continue;
      if (t.status === "PLANNED" || t.status === "IN_PROGRESS" || t.status === "LOCKED") {
        result.push(next);
      }
      // Always recurse: a downstream BLOCKED/ESCALATED node may itself have
      // PLANNED descendants we still want to cascade to.
      queue.push(next);
    }
  }

  return result;
}

// Transitive ancestor walk on the forward graph (dependencies). Used by
// fork-manifest.js to compute the affected DAG slice for council-tier picking.
function ancestors(graph, allIds, taskId) {
  const result = [];
  const visited = new Set([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of (graph[cur] || [])) {
      if (!allIds.has(next)) continue;
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
}

// Transitive descendant walk on the reverse graph. Includes ALL downstream
// regardless of status (used for slice scoping, not for cascade marking).
function descendants(reverse, allIds, taskId) {
  const result = [];
  const visited = new Set([taskId]);
  const queue = [taskId];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const next of (reverse[cur] || [])) {
      if (!allIds.has(next)) continue;
      if (visited.has(next)) continue;
      visited.add(next);
      result.push(next);
      queue.push(next);
    }
  }
  return result;
}

// Report which PLANNED tasks are blocked, broken down by what blocks them.
// Useful for diagnosing "loop stalled but tasks remain" — answers the question
// "are the remaining PLANNED tasks waiting on COMPLETE deps that never landed,
// or on ESCALATED deps that need re-queue, or on something else?"
function blockageReport(graph, allIds, stateFile) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  const tasks = state.tasks || {};

  // Bucket counts and example listings.
  const buckets = {}; // status -> { blocked_planned: Set<id>, blocking: Set<id> }
  const eligibleNow = [];
  const blockedDetail = []; // {id, blockers: [{id, status}]}

  for (const id of allIds) {
    const t = tasks[id];
    if (!t || t.status !== "PLANNED") continue;
    const deps = graph[id] || [];
    const blockers = [];
    for (const dep of deps) {
      if (!allIds.has(dep)) continue;
      const dt = tasks[dep];
      const ds = dt ? dt.status : "MISSING";
      if (ds !== "COMPLETE") blockers.push({ id: dep, status: ds });
    }
    if (blockers.length === 0) {
      eligibleNow.push(id);
    } else {
      blockedDetail.push({ id, blockers });
      for (const b of blockers) {
        if (!buckets[b.status]) buckets[b.status] = { blocked: new Set(), blocking: new Set() };
        buckets[b.status].blocked.add(id);
        buckets[b.status].blocking.add(b.id);
      }
    }
  }

  console.log("=== DAG BLOCKAGE REPORT ===");
  console.log(`PLANNED tasks: ${eligibleNow.length + blockedDetail.length}`);
  console.log(`  eligible NOW (all deps COMPLETE): ${eligibleNow.length}`);
  console.log(`  blocked: ${blockedDetail.length}`);
  console.log();
  console.log("Blockers by status:");
  for (const [status, info] of Object.entries(buckets)) {
    console.log(`  ${status}: blocking ${info.blocked.size} PLANNED task(s) via ${info.blocking.size} dep(s)`);
  }
  console.log();
  if (blockedDetail.length > 0) {
    console.log("Blocked tasks (first 30):");
    for (const item of blockedDetail.slice(0, 30)) {
      const summary = item.blockers.map(b => `${b.id}=${b.status}`).join(", ");
      console.log(`  ${item.id}  ←  ${summary}`);
    }
    if (blockedDetail.length > 30) console.log(`  ... and ${blockedDetail.length - 30} more`);
  }
  if (eligibleNow.length > 0) {
    console.log();
    console.log(`Eligible NOW (first 10): ${eligibleNow.slice(0, 10).join(", ")}${eligibleNow.length > 10 ? " ..." : ""}`);
  }
}

// Find critical junctions (nodes with 3+ dependents)
function findCriticalJunctions(graph, reverse, allIds) {
  const junctions = [];
  for (const id of allIds) {
    const dependentCount = (reverse[id] || []).length;
    if (dependentCount >= 3) {
      junctions.push({ id, dependent_count: dependentCount, dependents: reverse[id] });
    }
  }
  return junctions;
}

// ── Main ──
function main() {
  const args = parseArgs();
  if (!args.manifestDir || !args.action) {
    console.log("err:usage: node dag.js --manifest-dir <dir> --<action>");
    process.exit(1);
  }

  const level = args.level || "task";
  let dir;
  if (level === "epic") dir = path.join(args.manifestDir, "epics");
  else if (level === "group") dir = path.join(args.manifestDir, "task-groups");
  else dir = path.join(args.manifestDir, "tasks");

  const artifacts = loadArtifacts(dir);
  
  // Also try loading from monolithic council output files
  const monolithicFiles = ["csuite-output.yaml", "director-output.yaml", "engineer-output.yaml"];
  // (artifacts loaded from individual files take precedence)

  const { graph, reverse, allIds } = buildGraph(artifacts);

  switch (args.action) {
    case "check-cycles": {
      const cycles = detectCycles(graph, allIds);
      if (cycles.length === 0) {
        console.log("ok");
      } else {
        console.log(`err:cycles_detected:${JSON.stringify(cycles)}`);
      }
      break;
    }
    case "topo-sort": {
      const result = topoSort(graph, allIds);
      if (result.error) {
        console.log(`err:${result.error}`);
      } else {
        console.log(JSON.stringify(result.sorted));
      }
      break;
    }
    case "next-batch": {
      const batch = getNextBatch(graph, allIds, args.stateFile);
      console.log(JSON.stringify(batch));
      break;
    }
    case "critical-junctions": {
      const junctions = findCriticalJunctions(graph, reverse, allIds);
      console.log(JSON.stringify(junctions));
      break;
    }
    case "blockage-report": {
      blockageReport(graph, allIds, args.stateFile);
      break;
    }
    case "cascade-block": {
      const list = cascadeBlock(reverse, allIds, args.stateFile, args.taskId);
      console.log(JSON.stringify(list));
      break;
    }
    case "ancestors": {
      console.log(JSON.stringify(ancestors(graph, allIds, args.taskId)));
      break;
    }
    case "descendants": {
      console.log(JSON.stringify(descendants(reverse, allIds, args.taskId)));
      break;
    }
    default:
      console.log(`err:unknown action: ${args.action}`);
  }
}

main();
