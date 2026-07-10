#!/usr/bin/env node
/**
 * tsc-suggest-fix.js — Deterministic fixer for TypeScript's OWN suggestions
 *
 * Harvests the high-confidence `Did you mean …?` suggestions the TypeScript
 * compiler emits and applies them via the constrained edit-ops primitives.
 * This is the Bucket-A repair: the compiler hands you the exact replacement, so
 * no model judgment is needed. Anything outside the three self-suggested classes
 * below is REPORTED and SKIPPED — never guessed (no silent caps).
 *
 * Handled classes (compiler-authored suggestions only):
 *   H1  TS2613  default import where only a named export exists:
 *       `import X from "S"`  →  `import { X } from "S"`   (structural; the
 *       original specifier is preserved — TS's absolute-path suggestion ignored)
 *   H2  TS2339 / TS2551 / TS2552  `… 'X' does not exist … Did you mean 'Y'?`
 *       `Cannot find name 'X'. Did you mean 'Y'?`   →  line-scoped rename X → Y
 *   H3  TS2820 / TS2322 / TS2769  `Type '"X"' … Did you mean '"Y"'?`
 *       (e.g. sameSite: "Lax" → "lax")  →  line-scoped rename of literal X → Y
 *
 * Usage:
 *   node scripts/tsc-suggest-fix.js --project <dir> [--apply]
 *   node scripts/tsc-suggest-fix.js --from-file <tsc-output.txt> --root <dir> [--apply]
 *
 * Default is DRY-RUN (reports FIX/SKIP per diagnostic). `--apply` writes edits.
 * Always exits 0 (best-effort repair; the authoritative gate stays tsc/verify-build).
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const editOps = require("./edit-ops.js");

function parseArgs(argv) {
  const parsed = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project": parsed.project = argv[++i]; break;
      case "--from-file": parsed.fromFile = argv[++i]; break;
      case "--root": parsed.root = argv[++i]; break;
      case "--apply": parsed.apply = true; break;
    }
  }
  return parsed;
}

/**
 * Parse tsc --noEmit output into a list of actionable suggestions.
 * Each diagnostic line: `path(line,col): error TSxxxx: <message>`; the message
 * (and any continuation lines indented under it) may carry a `Did you mean …?`.
 * Returns: [{ file, line, col, code, handler, from, to, message }]
 *   handler ∈ {"default-import","rename","literal"}; entries without a handled
 *   suggestion are returned with handler:null so the caller can SKIP+report.
 */
function parseTscSuggestions(output) {
  const lines = String(output).split(/\r?\n/);
  const diagRe = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(diagRe);
    if (!m) continue;
    const [, file, lineStr, colStr, code] = m;
    // Gather the message plus any indented continuation lines (TS wraps the
    // "Did you mean" onto a following indented line for some codes).
    let message = m[5];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && !diagRe.test(lines[j])) {
      message += " " + lines[j].trim();
      j++;
    }
    const diag = {
      file,
      line: parseInt(lineStr, 10),
      col: parseInt(colStr, 10),
      code,
      message,
      handler: null,
      from: null,
      to: null,
    };
    classify(diag);
    results.push(diag);
  }
  return results;
}

// Mutates diag in place: sets handler/from/to when a handled suggestion is found.
function classify(diag) {
  const { code, message } = diag;

  // H1 — TS2613 default import where only a named export exists.
  // "Module '...' has no default export. Did you mean to use 'import { X } from "..."' instead?"
  if (code === "TS2613") {
    const m = message.match(/import\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/);
    if (m) {
      diag.handler = "default-import";
      diag.to = m[1]; // the named symbol to bind
      return;
    }
  }

  // H3 — quoted-literal suggestion: `Type '"X"' ... Did you mean '"Y"'?`
  // Check BEFORE H2 because these codes (TS2322/TS2820) also use "Did you mean".
  const litFrom = message.match(/Type '"([^"]+)"'/);
  const litTo = message.match(/Did you mean '"([^"]+)"'\s*\??/);
  if (litFrom && litTo) {
    diag.handler = "literal";
    diag.from = litFrom[1];
    diag.to = litTo[1];
    return;
  }

  // H2 — identifier rename: `... 'X' does not exist ... Did you mean 'Y'?`
  //                         `Cannot find name 'X'. Did you mean 'Y'?`
  const nameFrom =
    message.match(/Property '([A-Za-z_$][\w$]*)' does not exist/) ||
    message.match(/Cannot find name '([A-Za-z_$][\w$]*)'/);
  const nameTo = message.match(/Did you mean '([A-Za-z_$][\w$]*)'\s*\??/);
  if (nameFrom && nameTo) {
    diag.handler = "rename";
    diag.from = nameFrom[1];
    diag.to = nameTo[1];
    return;
  }
}

/**
 * Apply one classified diagnostic to its file content. Returns
 * { content, summary } on success, or { error } when the edit can't be made.
 */
// Replace a quoted string-literal value (single or double quotes), preserving
// the quote style. `line` (1-based) scopes the attempt; on a line miss it falls
// back to a whole-file replace but ONLY when exactly one quoted occurrence
// exists (so a same-spelled word in a comment can't make it ambiguous, and we
// never guess between multiple real literals). Returns {content,count,scope} or {error}.
function replaceQuotedLiteral(content, from, to, line) {
  const q = `(['"])${escapeRe(from)}\\1`;
  const lineRe = new RegExp(q, "g");
  const lines = content.split("\n");
  if (line >= 1 && line <= lines.length) {
    let n = 0;
    const newLine = lines[line - 1].replace(lineRe, (_m, quote) => { n++; return `${quote}${to}${quote}`; });
    if (n > 0) { lines[line - 1] = newLine; return { content: lines.join("\n"), count: n, scope: `line ${line}` }; }
  }
  const fileRe = new RegExp(q, "g");
  const matches = content.match(fileRe) || [];
  if (matches.length === 0) return { error: `no_quoted_literal:line ${line} and file-wide` };
  if (matches.length !== 1) return { error: `ambiguous:${matches.length} quoted literals (line ${line} miss)` };
  return { content: content.replace(fileRe, (_m, quote) => `${quote}${to}${quote}`), count: 1, scope: "file-wide" };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function applyFix(diag, content) {
  if (diag.handler === "literal") {
    const r = replaceQuotedLiteral(content, diag.from, diag.to, diag.line);
    if (r.error) return { error: r.error };
    return { content: r.content, summary: `"${diag.from}"→"${diag.to}" (${r.count}× ${r.scope})` };
  }
  if (diag.handler === "rename") {
    // Try the reported line first. TS often reports the error at the USAGE site
    // (e.g. a cookie() call) while the offending literal is defined a few lines
    // up in an options object — so on a line miss, fall back to a whole-file
    // rename, but ONLY when the token occurs exactly once (unambiguous). >1
    // occurrence → skip and report; never guess which one TS meant.
    const onLine = editOps.renameSymbol(content, diag.from, diag.to, diag.line);
    if (!onLine.error) {
      return { content: onLine.content, summary: `${diag.from}→${diag.to} (${onLine.count}× line ${diag.line})` };
    }
    if (onLine.error !== "no_match") {
      return { error: `${onLine.error}${onLine.detail ? ":" + onLine.detail : ""}` };
    }
    const whole = editOps.renameSymbol(content, diag.from, diag.to);
    if (whole.error) return { error: `no_match:line ${diag.line} and file-wide` };
    if (whole.count !== 1) return { error: `ambiguous:${whole.count}× in file (line ${diag.line} miss)` };
    return { content: whole.content, summary: `${diag.from}→${diag.to} (1× file-wide; reported line ${diag.line})` };
  }
  if (diag.handler === "default-import") {
    // Structural: fold the default import into the named group. Two forms:
    //   `import X from "S"`        → `import { X } from "S"`
    //   `import X, { A, B } from "S"` → `import { X, A, B } from "S"`
    // Preserve the original specifier; ignore TS's absolute-path suggestion.
    const lines = content.split("\n");
    if (diag.line < 1 || diag.line > lines.length) return { error: "line_out_of_range" };
    const orig = lines[diag.line - 1];
    const mixed = orig.match(/^(\s*import\s+)([A-Za-z_$][\w$]*)\s*,\s*\{\s*([^}]*?)\s*\}(\s+from\s+.*)$/);
    if (mixed) {
      const rebuilt = `${mixed[1]}{ ${mixed[2]}, ${mixed[3]} }${mixed[4]}`;
      const r = editOps.replaceLine(content, diag.line, rebuilt);
      if (r.error) return { error: r.error };
      return { content: r.content, summary: `default+named merged { ${mixed[2]}, … } (line ${diag.line})` };
    }
    const plain = orig.match(/^(\s*import\s+)([A-Za-z_$][\w$]*)(\s+from\s+.*)$/);
    if (plain) {
      const rebuilt = `${plain[1]}{ ${plain[2]} }${plain[3]}`;
      const r = editOps.replaceLine(content, diag.line, rebuilt);
      if (r.error) return { error: r.error };
      return { content: r.content, summary: `default→named { ${plain[2]} } (line ${diag.line})` };
    }
    return { error: "no_default_import_on_line" };
  }
  return { error: "unhandled" };
}

function resolveFilePath(file, root) {
  if (path.isAbsolute(file)) return file;
  return root ? path.resolve(root, file) : path.resolve(file);
}

function getTscOutput(opts) {
  if (opts.fromFile) {
    return fs.readFileSync(opts.fromFile, "utf-8");
  }
  // Run tsc in the project dir. tsc exits non-zero when there are errors — that
  // is expected; capture stdout regardless. --pretty false forces the plain
  // `path(line,col): error TSxxxx:` format diagRe parses (a tsconfig with
  // "pretty": true would otherwise colorize piped output and match nothing).
  try {
    execSync("npx tsc --noEmit --pretty false", { cwd: opts.project, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return ""; // no errors
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.project && !opts.fromFile) {
    console.log("err:--project or --from-file required");
    process.exit(0);
  }
  const root = opts.root || opts.project || ".";
  const output = getTscOutput(opts);
  const diags = parseTscSuggestions(output);

  // Group handled diagnostics by file so multi-fix files are read/written once.
  // Apply in descending line order within a file so earlier edits never shift
  // the line numbers of later ones.
  const byFile = new Map();
  let skipped = 0;
  for (const d of diags) {
    if (!d.handler) {
      console.log(`SKIP ${d.code} ${path.relative(root, resolveFilePath(d.file, root))}:${d.line} (no handled suggestion)`);
      skipped++;
      continue;
    }
    const abs = resolveFilePath(d.file, root);
    if (!byFile.has(abs)) byFile.set(abs, []);
    byFile.get(abs).push(d);
  }

  let applied = 0;
  for (const [abs, list] of byFile) {
    if (!fs.existsSync(abs)) {
      for (const d of list) { console.log(`SKIP ${d.code} ${abs}:${d.line} (file not found)`); skipped++; }
      continue;
    }
    let content = fs.readFileSync(abs, "utf-8");
    list.sort((a, b) => b.line - a.line);
    let changed = false;
    for (const d of list) {
      const res = applyFix(d, content);
      const rel = path.relative(root, abs);
      if (res.error) {
        console.log(`SKIP ${d.code} ${rel}:${d.line} (${res.error})`);
        skipped++;
        continue;
      }
      content = res.content;
      changed = true;
      applied++;
      console.log(`FIX  ${d.code} ${rel}:${d.line} ${res.summary}`);
    }
    if (changed && opts.apply) {
      editOps.writeFileAtomic(abs, content);
    }
  }

  const mode = opts.apply ? "applied" : "would-fix";
  console.log(`ok:${mode} ${applied}, skipped ${skipped}`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { parseTscSuggestions, classify, applyFix };
