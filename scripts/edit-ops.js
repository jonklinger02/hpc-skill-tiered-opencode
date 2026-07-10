#!/usr/bin/env node
/**
 * edit-ops.js — Constrained, deterministic file editor for HPC retry-update worker
 *
 * PURE logic: no network, no model calls. Applies bounded, located edits to files.
 * Keeps mechanical editing off the LLM (the LLM only chooses the strategy).
 *
 * Subcommands:
 *   rename-symbol --file F --from X --to Y [--line N] [--count-only]
 *   add-export   --file F --statement "<full line>"
 *   replace-line --file F --line N --to "<new full line content>"
 *
 * Usage:
 *   node scripts/edit-ops.js rename-symbol --file src/config.ts --from ConfigStore --to IConfigStore
 *   node scripts/edit-ops.js rename-symbol --file src/config.ts --from ConfigStore --to IConfigStore --line 42
 *   node scripts/edit-ops.js add-export --file src/index.ts --statement "export { IConfigStore } from './schema';"
 *   node scripts/edit-ops.js replace-line --file src/index.ts --line 10 --to "const x = 42;"
 *
 * Output: one stdout line `ok:<summary>` on success, `err:<reason>` on error + exit 1.
 * Atomic writes (tmp + rename).
 */

const fs = require("fs");
const path = require("path");

/**
 * Parse CLI args into { action, file, from, to, line, statement, countOnly }
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    action: args[0],
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--file":
        parsed.file = args[++i];
        break;
      case "--from":
        parsed.from = args[++i];
        break;
      case "--to":
        parsed.to = args[++i];
        break;
      case "--line":
        parsed.lineRaw = args[++i];
        parsed.line = parseInt(parsed.lineRaw, 10);
        break;
      case "--statement":
        parsed.statement = args[++i];
        break;
      case "--count-only":
        parsed.countOnly = true;
        break;
    }
  }

  return parsed;
}

/**
 * Check if a string is a valid JavaScript identifier.
 * Valid: ^[A-Za-z_$][\w$]*$
 */
function isValidIdentifier(name) {
  if (!name || typeof name !== "string") return false;
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * Rename occurrences of oldName to newName with word-boundary safety.
 * Pattern: (?<![\w$])oldName(?![\w$])
 * If lineNum (1-based) is provided, rename only on that line.
 * Returns { count, content, lineNum? } or null if no match or error.
 */
function renameSymbol(content, oldName, newName, lineNum = null) {
  // Validate identifiers
  if (!isValidIdentifier(oldName)) {
    return { error: "bad_identifier", detail: `--from "${oldName}" is not a valid identifier` };
  }
  if (!isValidIdentifier(newName)) {
    return { error: "bad_identifier", detail: `--to "${newName}" is not a valid identifier` };
  }

  // Build regex with word-boundary lookarounds
  const pattern = new RegExp(`(?<!\\w|\\$)${escapeRegex(oldName)}(?!\\w|\\$)`, "g");

  if (lineNum !== null && lineNum !== undefined) {
    // Single-line rename
    const lines = content.split("\n");
    if (lineNum < 1 || lineNum > lines.length) {
      return { error: "line_out_of_range", lineNum };
    }

    const targetLine = lines[lineNum - 1];
    let count = 0;
    let newLine = targetLine.replace(pattern, () => {
      count++;
      return newName;
    });

    if (count === 0) {
      return { error: "no_match", detail: `${oldName} not found on line ${lineNum}` };
    }

    lines[lineNum - 1] = newLine;
    return {
      count,
      content: lines.join("\n"),
      lineNum,
    };
  } else {
    // Whole-file rename
    let count = 0;
    const newContent = content.replace(pattern, () => {
      count++;
      return newName;
    });

    if (count === 0) {
      return { error: "no_match", detail: `${oldName} not found` };
    }

    return { count, content: newContent };
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add an export statement to the file. If already present, no-op (ok:already_present).
 * Otherwise append it on a new line, preserving trailing newline.
 */
function addExport(content, statement) {
  // Validate that statement looks like an export
  if (!/^\s*export\b/.test(statement)) {
    return { error: "not_an_export_statement" };
  }

  // Check if already present
  const lines = content.split("\n");
  const statementTrimmed = statement.trim();
  for (const line of lines) {
    if (line.trim() === statementTrimmed) {
      return { alreadyPresent: true };
    }
  }

  // Append statement
  let newContent = content;
  if (!newContent.endsWith("\n")) {
    newContent += "\n";
  }
  newContent += statement + "\n";

  return { content: newContent };
}

/**
 * Replace the entire content of line N (1-based) with newLineContent.
 */
function replaceLine(content, lineNum, newLineContent) {
  const lines = content.split("\n");
  if (lineNum < 1 || lineNum > lines.length) {
    return { error: "line_out_of_range", lineNum };
  }

  lines[lineNum - 1] = newLineContent;
  return { content: lines.join("\n"), lineNum };
}

/**
 * Write content to file atomically (tmp + rename).
 */
function writeFileAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

/**
 * Main entry point
 */
function main() {
  const parsed = parseArgs();
  const action = parsed.action;

  // Numeric-flag guard: a non-integer --line (e.g. "twelve") must fail loudly
  // instead of flowing through as NaN (which passes range checks vacuously and
  // reports a bogus ok:... with the file unchanged).
  if (parsed.lineRaw !== undefined && !Number.isInteger(parsed.line)) {
    console.log(`err:invalid_line:${parsed.lineRaw}`);
    process.exit(1);
  }

  try {
    if (action === "rename-symbol") {
      // Validate required args
      if (!parsed.file) {
        console.log("err:missing --file");
        process.exit(1);
      }
      if (!parsed.from) {
        console.log("err:missing --from");
        process.exit(1);
      }
      if (!parsed.to) {
        console.log("err:missing --to");
        process.exit(1);
      }

      // Check file exists
      if (!fs.existsSync(parsed.file)) {
        console.log("err:file_not_found");
        process.exit(1);
      }

      // Read file
      const content = fs.readFileSync(parsed.file, "utf-8");

      // Perform rename
      const result = renameSymbol(content, parsed.from, parsed.to, parsed.line);

      if (result.error) {
        if (result.error === "bad_identifier") {
          console.log("err:bad_identifier");
        } else if (result.error === "line_out_of_range") {
          console.log("err:line_out_of_range");
        } else if (result.error === "no_match") {
          if (parsed.line) {
            console.log(`err:no_match:${parsed.from} not found on line ${parsed.line}`);
          } else {
            console.log(`err:no_match:${parsed.from} not found`);
          }
        }
        process.exit(1);
      }

      // If count-only, don't write
      if (parsed.countOnly) {
        if (result.lineNum) {
          console.log(`ok:renamed ${result.count} occurrence(s) line ${result.lineNum}`);
        } else {
          console.log(`ok:renamed ${result.count} occurrence(s)`);
        }
      } else {
        // Write file
        writeFileAtomic(parsed.file, result.content);
        if (result.lineNum) {
          console.log(`ok:renamed ${result.count} occurrence(s) line ${result.lineNum}`);
        } else {
          console.log(`ok:renamed ${result.count} occurrence(s)`);
        }
      }
    } else if (action === "add-export") {
      // Validate required args
      if (!parsed.file) {
        console.log("err:missing --file");
        process.exit(1);
      }
      if (!parsed.statement) {
        console.log("err:missing --statement");
        process.exit(1);
      }

      // Check file exists
      if (!fs.existsSync(parsed.file)) {
        console.log("err:file_not_found");
        process.exit(1);
      }

      // Read file
      const content = fs.readFileSync(parsed.file, "utf-8");

      // Perform add-export
      const result = addExport(content, parsed.statement);

      if (result.error) {
        console.log("err:" + result.error);
        process.exit(1);
      }

      if (result.alreadyPresent) {
        console.log("ok:already_present");
      } else {
        // Write file
        writeFileAtomic(parsed.file, result.content);
        console.log("ok:export_added");
      }
    } else if (action === "replace-line") {
      // Validate required args
      if (!parsed.file) {
        console.log("err:missing --file");
        process.exit(1);
      }
      if (parsed.line === undefined || parsed.line === null) {
        console.log("err:missing --line");
        process.exit(1);
      }
      if (parsed.to === undefined) {
        console.log("err:missing --to");
        process.exit(1);
      }

      // Check file exists
      if (!fs.existsSync(parsed.file)) {
        console.log("err:file_not_found");
        process.exit(1);
      }

      // Read file
      const content = fs.readFileSync(parsed.file, "utf-8");

      // Perform replace-line
      const result = replaceLine(content, parsed.line, parsed.to);

      if (result.error) {
        console.log("err:" + result.error);
        process.exit(1);
      }

      // Write file
      writeFileAtomic(parsed.file, result.content);
      console.log(`ok:line_replaced ${result.lineNum}`);
    } else {
      console.log("err:unknown action: " + action);
      process.exit(1);
    }
  } catch (e) {
    console.log("err:" + e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// Exported so other deterministic tools (e.g. tsc-suggest-fix.js) can reuse the
// constrained edit primitives without shelling out. CLI behavior is unchanged.
module.exports = {
  renameSymbol,
  addExport,
  replaceLine,
  isValidIdentifier,
  escapeRegex,
  writeFileAtomic,
};
