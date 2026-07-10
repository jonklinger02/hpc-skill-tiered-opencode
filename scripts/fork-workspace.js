#!/usr/bin/env node
/**
 * fork-workspace.js — Snapshot an HPC workspace for audit trail at Tier 3+ recovery.
 *
 * Usage:
 *   node fork-workspace.js --workspace <path-to-hpc-workspace> [--reason <text>]
 *   node fork-workspace.js --workspace <path> --list
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace") {
      parsed.workspace = args[++i];
    } else if (args[i] === "--reason") {
      parsed.reason = args[++i];
    } else if (args[i] === "--list") {
      parsed.list = true;
    }
  }
  return parsed;
}

function validateWorkspace(workspacePath) {
  if (!workspacePath) {
    return false;
  }
  try {
    const stat = fs.statSync(workspacePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function getNextIterationNumber(workspacePath) {
  const parent = path.dirname(workspacePath);
  const basename = path.basename(workspacePath);
  const prefix = basename + ".tier3-iteration-";

  let maxK = 0;
  try {
    const entries = fs.readdirSync(parent);
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const kStr = entry.substring(prefix.length);
        const k = parseInt(kStr, 10);
        if (!isNaN(k) && k > maxK) {
          maxK = k;
        }
      }
    }
  } catch {
    // Parent dir may not exist or not readable; start at 1
  }

  return maxK + 1;
}

function shouldExcludePath(fullPath, relativePath) {
  // Split the path into segments
  const segments = relativePath.split(path.sep).filter(s => s);

  // Exclude if any segment is in the exclusion list
  const excludeSegments = ["node_modules", ".git", "execute-logs"];
  for (const seg of segments) {
    if (excludeSegments.includes(seg)) {
      return true;
    }
  }

  return false;
}

function copyWorkspace(srcPath, destPath) {
  fs.cpSync(srcPath, destPath, {
    recursive: true,
    filter: (src, dest) => {
      const relativePath = path.relative(srcPath, src);
      return !shouldExcludePath(src, relativePath);
    }
  });
}

function createOrUpdateSymlink(linkPath, targetPath) {
  // Try to remove existing symlink or file
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // File doesn't exist, that's fine
  }

  // Try to create symlink
  try {
    fs.symlinkSync(targetPath, linkPath);
    return { type: "symlink", path: linkPath };
  } catch {
    // Symlink creation failed (e.g., unsupported FS); write plain file instead
    fs.writeFileSync(linkPath, targetPath);
    return { type: "file", path: linkPath };
  }
}

function appendAuditLine(workspacePath, destPath, reason) {
  const wikiDir = path.join(workspacePath, "wiki");
  const auditFile = path.join(wikiDir, "autonomous-decisions.yaml");

  try {
    fs.mkdirSync(wikiDir, { recursive: true });

    const timestamp = new Date().toISOString();
    const decision = `Forked workspace to ${destPath}`;
    const auditLine = `- timestamp: "${timestamp}"\n  tier: "M5_TIER_3"\n  decision: "${decision}"\n  reason: "${reason}"\n`;

    // Append to file
    fs.appendFileSync(auditFile, auditLine);
  } catch {
    // Best-effort; don't error if audit write fails
  }
}

function listForks(workspacePath) {
  const parent = path.dirname(workspacePath);
  const basename = path.basename(workspacePath);
  const prefix = basename + ".tier3-iteration-";

  const forks = [];
  try {
    const entries = fs.readdirSync(parent);
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        forks.push(entry);
      }
    }
  } catch {
    // Parent dir may not exist
  }

  // Sort by iteration number
  forks.sort((a, b) => {
    const kA = parseInt(a.substring(prefix.length), 10);
    const kB = parseInt(b.substring(prefix.length), 10);
    return kA - kB;
  });

  // Resolve current symlink
  const currentLink = path.join(parent, basename + ".current");
  let currentResolved = "none";
  try {
    const stat = fs.lstatSync(currentLink);
    if (stat.isSymbolicLink()) {
      currentResolved = path.basename(fs.readlinkSync(currentLink));
    } else if (stat.isFile()) {
      const content = fs.readFileSync(currentLink, "utf-8").trim();
      currentResolved = path.basename(content);
    }
  } catch {
    // Current link doesn't exist
  }

  const forksList = forks.join(", ");
  console.log(`ok:forks=[${forksList}] current=${currentResolved}`);
}

function main() {
  const args = parseArgs();

  if (!args.workspace) {
    console.log("err:--workspace required");
    process.exit(1);
  }

  if (!validateWorkspace(args.workspace)) {
    console.log("err:--workspace must be a valid directory");
    process.exit(1);
  }

  if (args.list) {
    listForks(args.workspace);
    return;
  }

  // Snapshot mode
  const workspacePath = path.resolve(args.workspace);
  const parent = path.dirname(workspacePath);
  const basename = path.basename(workspacePath);
  const iterationNumber = getNextIterationNumber(workspacePath);
  const destName = `${basename}.tier3-iteration-${iterationNumber}`;
  const destPath = path.join(parent, destName);

  // Copy workspace
  copyWorkspace(workspacePath, destPath);

  // Create/update symlink
  const currentLink = path.join(parent, basename + ".current");
  const linkResult = createOrUpdateSymlink(currentLink, destPath);

  // Append audit line
  const reason = args.reason || "tier3-escalation";
  appendAuditLine(workspacePath, destPath, reason);

  // Print success
  console.log(`ok:forked=${destPath} iteration=${iterationNumber} current=${linkResult.path}`);
}

main();
