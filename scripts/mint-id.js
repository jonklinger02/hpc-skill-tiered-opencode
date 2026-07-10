#!/usr/bin/env node
/**
 * mint-id.js — Canonical ID minting for HPC planning councils
 *
 * Mints collision-free IDs for epics, task groups, tasks, and contracts.
 * Safe under parallel callers via atomic file locking.
 *
 * Usage:
 *   node mint-id.js --manifest-dir <dir> --type <epic|task_group|task|contract> \
 *     [--area <AREA>] [--domain <DOMAIN>] [--count <N>]
 *
 * Output: one ID per line (no prose), or "err:<reason>" on error, exit 1.
 */

const fs = require("fs");
const path = require("path");

/**
 * Canonical ID formats:
 *   epic       → EPIC-<NNN>
 *   task_group → GRP-<AREA>-<NNN>
 *   task       → TASK-<AREA>-<NNNN>
 *   contract   → CONTRACT-<DOMAIN>-<NNN>
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir":
        parsed.manifestDir = args[++i];
        break;
      case "--type":
        parsed.type = args[++i];
        break;
      case "--area":
        parsed.area = args[++i];
        break;
      case "--domain":
        parsed.domain = args[++i];
        break;
      case "--count":
        parsed.count = parseInt(args[++i], 10);
        break;
    }
  }
  return parsed;
}

/**
 * Normalize an area or domain string:
 * - Convert to uppercase
 * - Keep only [A-Z0-9] and hyphens between segments
 */
function normalizeAreaDomain(input) {
  if (!input) return "";
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Scan manifest directory for existing canonical IDs matching the given type and area/domain.
 * Returns the highest number found (or 0 if none).
 */
function scanManifest(manifestDir, type, areaDomain) {
  let maxNumber = 0;

  try {
    if (type === "epic") {
      const epicsDir = path.join(manifestDir, "epics");
      if (fs.existsSync(epicsDir)) {
        for (const f of fs.readdirSync(epicsDir)) {
          if (!f.endsWith(".yaml")) continue;
          const content = fs.readFileSync(path.join(epicsDir, f), "utf-8");
          const match = content.match(/^epic_id:\s*"?EPIC-(\d+)"?/m);
          if (match) {
            const num = parseInt(match[1], 10);
            maxNumber = Math.max(maxNumber, num);
          }
        }
      }
    } else if (type === "task_group") {
      const groupsDir = path.join(manifestDir, "task-groups");
      if (fs.existsSync(groupsDir)) {
        for (const f of fs.readdirSync(groupsDir)) {
          // Skip subdirectories and _raw
          if (f.startsWith("_")) continue;
          const fullPath = path.join(groupsDir, f);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) continue;

          if (!f.endsWith(".yaml")) continue;
          const content = fs.readFileSync(fullPath, "utf-8");
          const match = content.match(
            new RegExp(`^group_id:\\s*"?GRP-${areaDomain}-(\\d+)"?`, "m")
          );
          if (match) {
            const num = parseInt(match[1], 10);
            maxNumber = Math.max(maxNumber, num);
          }
        }
      }
    } else if (type === "task") {
      const tasksDir = path.join(manifestDir, "tasks");
      if (fs.existsSync(tasksDir)) {
        for (const f of fs.readdirSync(tasksDir)) {
          if (!f.endsWith(".yaml")) continue;
          const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
          const match = content.match(
            new RegExp(`^task_id:\\s*"?TASK-${areaDomain}-(\\d+)"?`, "m")
          );
          if (match) {
            const num = parseInt(match[1], 10);
            maxNumber = Math.max(maxNumber, num);
          }
        }
      }
    } else if (type === "contract") {
      const contractsDir = path.join(manifestDir, "contracts");
      if (fs.existsSync(contractsDir)) {
        for (const f of fs.readdirSync(contractsDir)) {
          if (!f.endsWith(".yaml")) continue;
          const content = fs.readFileSync(path.join(contractsDir, f), "utf-8");
          const match = content.match(
            new RegExp(`^contract_id:\\s*"?CONTRACT-${areaDomain}-(\\d+)"?`, "m")
          );
          if (match) {
            const num = parseInt(match[1], 10);
            maxNumber = Math.max(maxNumber, num);
          }
        }
      }
    }
  } catch (e) {
    // Scan errors are non-fatal; continue with maxNumber as-is
  }

  return maxNumber;
}

/**
 * Exclusive file lock via O_EXCL lockfile. Retries with backoff up to ~6 seconds.
 * Returns lock-fd or throws on timeout.
 * Mirrors the pattern in task-store.js.
 */
function acquireLock(lockFile) {
  const deadline = Date.now() + 6000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, `pid=${process.pid} t=${Date.now()}`);
      return { fd, lockFile };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Stale-lock recovery: if lockfile is older than 30s, remove it.
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > 30000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {}
      attempt++;
      const sleep = Math.min(50 * Math.pow(1.5, attempt), 500);
      const end = Date.now() + sleep;
      while (Date.now() < end) {} // busy-wait
    }
  }
  throw new Error("lock_timeout: could not acquire " + lockFile);
}

function releaseLock(handle) {
  try {
    fs.closeSync(handle.fd);
  } catch {}
  try {
    fs.unlinkSync(handle.lockFile);
  } catch {}
}

/**
 * Mint one or more consecutive IDs for the given type and area/domain.
 * Updates the counter file atomically under lock.
 */
function mintIds(manifestDir, type, areaDomain, count) {
  const counterFile = path.join(manifestDir, ".id-counters.json");
  const lockFile = counterFile + ".lock";

  const handle = acquireLock(lockFile);
  try {
    // Read existing counters (or start fresh)
    let counters = {};
    if (fs.existsSync(counterFile)) {
      try {
        counters = JSON.parse(fs.readFileSync(counterFile, "utf-8"));
      } catch (e) {
        counters = {};
      }
    }

    // Determine the bucket key
    const bucket = `${type}:${areaDomain}`;

    // Scan manifest to find the highest existing number
    const scanMax = scanManifest(manifestDir, type, areaDomain);

    // Compute next number: 1 + max(scanMax, counter[bucket]||0)
    const lastNumber = counters[bucket] || 0;
    const start = Math.max(scanMax, lastNumber) + 1;
    const end = start + count - 1;

    // Update counter
    counters[bucket] = end;

    // Write atomically
    const tmp = counterFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(counters, null, 2));
    fs.renameSync(tmp, counterFile);

    // Generate IDs
    const ids = [];
    for (let i = start; i <= end; i++) {
      ids.push(formatId(type, areaDomain, i));
    }

    return ids;
  } finally {
    releaseLock(handle);
  }
}

/**
 * Format a single ID for the given type and number.
 */
function formatId(type, areaDomain, number) {
  if (type === "epic") {
    return `EPIC-${String(number).padStart(3, "0")}`;
  } else if (type === "task_group") {
    return `GRP-${areaDomain}-${String(number).padStart(3, "0")}`;
  } else if (type === "task") {
    return `TASK-${areaDomain}-${String(number).padStart(4, "0")}`;
  } else if (type === "contract") {
    return `CONTRACT-${areaDomain}-${String(number).padStart(3, "0")}`;
  }
  return "";
}

function main() {
  const args = parseArgs();

  // Validate required args
  if (!args.manifestDir) {
    console.log("err:missing --manifest-dir");
    process.exit(1);
  }
  if (!args.type) {
    console.log("err:missing --type");
    process.exit(1);
  }

  const count = args.count || 1;

  // Validate type and extract area/domain
  let areaDomain = "";

  if (args.type === "epic") {
    // Epic needs neither area nor domain
    areaDomain = "";
  } else if (args.type === "task_group") {
    if (!args.area) {
      console.log("err:task_group requires --area");
      process.exit(1);
    }
    areaDomain = normalizeAreaDomain(args.area);
    if (!areaDomain) {
      console.log("err:invalid area after normalization");
      process.exit(1);
    }
  } else if (args.type === "task") {
    if (!args.area) {
      console.log("err:task requires --area");
      process.exit(1);
    }
    areaDomain = normalizeAreaDomain(args.area);
    if (!areaDomain) {
      console.log("err:invalid area after normalization");
      process.exit(1);
    }
  } else if (args.type === "contract") {
    // Contract prefers --domain, falls back to --area
    const domain = args.domain || args.area;
    if (!domain) {
      console.log("err:contract requires --domain or --area");
      process.exit(1);
    }
    areaDomain = normalizeAreaDomain(domain);
    if (!areaDomain) {
      console.log("err:invalid domain after normalization");
      process.exit(1);
    }
  } else {
    console.log("err:unknown type: " + args.type);
    process.exit(1);
  }

  try {
    const ids = mintIds(args.manifestDir, args.type, areaDomain, count);
    for (const id of ids) {
      console.log(id);
    }
  } catch (e) {
    console.log("err:" + e.message);
    process.exit(1);
  }
}

main();
