#!/usr/bin/env node
/**
 * assemble.js — Final assembly and validation
 * 
 * Validates all files exist, all contracts are satisfied,
 * and the wiki is complete. Reports final status.
 * 
 * Usage:
 *   node assemble.js --output-dir <dir> --wiki-dir <dir> --manifest-dir <dir>
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--output-dir": parsed.outputDir = args[++i]; break;
      case "--wiki-dir": parsed.wikiDir = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
    }
  }
  return parsed;
}

function extractField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return match ? match[1].trim() : null;
}

function main() {
  const args = parseArgs();
  const issues = [];
  const stats = { total: 0, present: 0, missing: 0, withFrontmatter: 0, withSynopsis: 0 };

  // Check every task's output file exists
  const tasksDir = path.join(args.manifestDir, "tasks");
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith(".yaml")) continue;
      const content = fs.readFileSync(path.join(tasksDir, f), "utf-8");
      const taskId = extractField(content, "task_id");
      const filePath = extractField(content, "file_path");
      
      if (!filePath) continue;
      stats.total++;

      const fullPath = path.join(args.outputDir, filePath);
      if (fs.existsSync(fullPath)) {
        stats.present++;
        
        // Check frontmatter
        const fileContent = fs.readFileSync(fullPath, "utf-8");
        if (fileContent.startsWith("---")) {
          stats.withFrontmatter++;
        } else {
          issues.push(`${taskId}: missing frontmatter in ${filePath}`);
        }
        
        // Check synopsis
        if (fileContent.includes("# SYNOPSIS")) {
          stats.withSynopsis++;
        } else {
          issues.push(`${taskId}: missing synopsis in ${filePath}`);
        }
      } else {
        stats.missing++;
        issues.push(`${taskId}: output file missing: ${filePath}`);
      }
    }
  }

  // Generate final progress report
  const reportFile = path.join(args.wikiDir, "assembly-report.yaml");
  const report = [
    `assembly_timestamp: "${new Date().toISOString()}"`,
    `total_expected_files: ${stats.total}`,
    `files_present: ${stats.present}`,
    `files_missing: ${stats.missing}`,
    `files_with_frontmatter: ${stats.withFrontmatter}`,
    `files_with_synopsis: ${stats.withSynopsis}`,
    `issues_count: ${issues.length}`,
    issues.length > 0 ? `issues:\n${issues.map(i => `  - "${i}"`).join("\n")}` : "issues: []",
  ].join("\n");
  
  fs.writeFileSync(reportFile, report);

  if (issues.length === 0) {
    console.log(`ok:assembly complete — ${stats.present}/${stats.total} files, all with frontmatter and synopsis`);
  } else {
    console.log(`err:assembly incomplete — ${stats.present}/${stats.total} files present, ${issues.length} issues (see ${reportFile})`);
  }
}

main();
