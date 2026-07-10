#!/usr/bin/env node
/**
 * split-council-output.js — Split a monolithic council YAML into per-artifact files
 *
 * The subagent.js writeCouncilArtifacts function writes one big YAML per
 * council. Validators and downstream tiers expect per-epic / per-group /
 * per-task / per-contract files in the conventional manifest layout:
 *
 *   manifest/epics/EPIC-NNN.yaml             (one per epic)
 *   manifest/architecture.yaml               (single)
 *   manifest/dag-skeleton.yaml               (single)
 *   manifest/functional-areas.yaml           (single)
 *   manifest/task-groups/GRP-{AREA}-NNN.yaml (one per group)
 *   manifest/contracts/CONTRACT-{...}.yaml   (one per contract)
 *   manifest/ownership.yaml                  (single)
 *   manifest/tasks/TASK-{AREA}-NNNN.yaml     (one per task)
 *   manifest/file-tree.yaml                  (single)
 *   manifest/contract-xrefs.yaml             (single)
 *   manifest/deliberations/{tier}-decisions-log.yaml (single, archive)
 *
 * Top-level YAML keys are split into files. Sequence-of-objects keys
 * (epics, task_groups, tasks, contracts) are exploded into per-item files
 * keyed by the item's first id-like field.
 *
 * Usage:
 *   node split-council-output.js --input <monolithic.yaml> --manifest-dir <dir> --tier <csuite|director|engineer>
 *
 * Nested structures (e.g. a contract's `surface:` block, a task's structured
 * `contracts_consumed: [{contract_id, invokes}]` array) pass through verbatim:
 * the dedent only strips the per-item-marker indentation (4 chars), so deeper
 * nested arrays/maps retain their relative shape. This is intentional — the
 * Director and Engineer councils now produce binding contracts whose surface
 * and task invokes/implements arrays must survive the split unmodified.
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input": parsed.input = args[++i]; break;
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--tier": parsed.tier = args[++i]; break;
    }
  }
  return parsed;
}

// Split monolithic YAML into top-level sections by zero-indent key.
// Returns { sectionName: rawBodyLines (no leading key line, original indent preserved) }.
function splitTopLevelSections(yamlText) {
  const lines = yamlText.split("\n");
  const sections = {};
  let currentKey = null;
  let buffer = [];

  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
    if (m) {
      if (currentKey !== null) sections[currentKey] = buffer.join("\n");
      currentKey = m[1];
      buffer = [];
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  if (currentKey !== null) sections[currentKey] = buffer.join("\n");
  return sections;
}

// Split a YAML sequence-of-mappings body into individual items, de-indented
// so each item's fields are at column 0 (well-formed standalone YAML).
//
// Input shape (under a parent key at col 0):
//   `  - epic_id: EPIC-001`     -> becomes `epic_id: EPIC-001`
//   `    name: ...`             -> becomes `name: ...`
//   `    acceptance_criteria:`  -> becomes `acceptance_criteria:`
//   `      - "..."`             -> becomes `  - "..."`
//
// The first line of each item is the `  - <field>: <val>` marker. We strip
// the leading `  - ` (4 chars) and dedent every subsequent line by 4 chars.
function splitSequenceItems(body, idFields) {
  const lines = body.split("\n");
  const items = [];
  let raw = [];
  let inItem = false;

  function dedent(itemLines) {
    if (itemLines.length === 0) return "";
    const out = [];
    // First line: `  - field: val` → `field: val`
    out.push(itemLines[0].replace(/^  - /, ""));
    for (let i = 1; i < itemLines.length; i++) {
      out.push(itemLines[i].replace(/^ {4}/, ""));
    }
    return out.join("\n");
  }

  function flush() {
    if (!inItem || raw.length === 0) return;
    const dedented = dedent(raw);
    let idValue = null;
    let idField = null;
    for (const f of idFields) {
      const re = new RegExp(`^${f}:\\s*"?([^"\\n]+?)"?\\s*$`, "m");
      const m = dedented.match(re);
      if (m) { idField = f; idValue = m[1].trim(); break; }
    }
    items.push({ idField, idValue, body: dedented });
    raw = [];
  }

  for (const line of lines) {
    if (/^  - /.test(line)) {
      flush();
      inItem = true;
      raw.push(line);
    } else if (inItem) {
      raw.push(line);
    }
  }
  flush();
  return items;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function main() {
  const args = parseArgs();
  if (!args.input || !args.manifestDir || !args.tier) {
    console.log("err:missing args (--input, --manifest-dir, --tier)");
    process.exit(1);
  }

  let yamlText = fs.readFileSync(args.input, "utf-8");

  // Strip "piece N of M" prose dividers some councils insert when they self-
  // chunk output near the token budget. These are markdown artefacts that
  // confuse the YAML parser: `**Piece 3 of 4 — contracts ...**` followed by
  // `---` (horizontal rule). The dividers carry no semantic content and
  // belong nowhere in the manifest. Strip them aggressively before splitting.
  yamlText = yamlText
    .replace(/^\*\*Piece\s+\d+\s+of\s+\d+.*\*\*\s*$/gim, "")
    .replace(/^---\s*$\n(?=\s*$|\s*\*\*Piece)/gim, "")  // standalone horizontal rules between pieces
    .replace(/^---\s*$/gim, (m, offset, full) => {
      // Drop `---` lines that appear at the start of a line and aren't YAML
      // document separators in context. A real YAML doc separator at column 0
      // is rare in our outputs; piece-dividers are common. Drop unconditionally.
      return "";
    });

  const sections = splitTopLevelSections(yamlText);

  const md = args.manifestDir;
  let written = 0;
  const log = [];

  // Per-tier mapping: top-level key -> handler
  const handlers = {
    epics: (body) => {
      const items = splitSequenceItems(body, ["epic_id"]);
      for (const it of items) {
        const id = it.idValue || `EPIC-UNKNOWN-${++written}`;
        const file = path.join(md, "epics", `${id}.yaml`);
        writeFile(file, `${it.body}\n`);
        written++;
      }
      log.push(`epics: ${items.length} files`);
    },
    architecture: (body) => {
      writeFile(path.join(md, "architecture.yaml"), `architecture:\n${body}\n`);
      written++;
      log.push("architecture.yaml");
    },
    dag: (body) => {
      writeFile(path.join(md, "dag-skeleton.yaml"), `dag:\n${body}\n`);
      written++;
      log.push("dag-skeleton.yaml");
    },
    dag_skeleton: (body) => {
      writeFile(path.join(md, "dag-skeleton.yaml"), `dag_skeleton:\n${body}\n`);
      written++;
      log.push("dag-skeleton.yaml");
    },
    functional_areas: (body) => {
      writeFile(path.join(md, "functional-areas.yaml"), `functional_areas:\n${body}\n`);
      written++;
      log.push("functional-areas.yaml");
    },
    task_groups: (body) => {
      const items = splitSequenceItems(body, ["group_id"]);
      for (const it of items) {
        const id = it.idValue || `GRP-UNKNOWN-${++written}`;
        const file = path.join(md, "task-groups", `${id}.yaml`);
        writeFile(file, `${it.body}\n`);
        written++;
      }
      log.push(`task_groups: ${items.length} files`);
    },
    contracts: (body) => {
      const items = splitSequenceItems(body, ["contract_id"]);
      for (const it of items) {
        const id = it.idValue || `CONTRACT-UNKNOWN-${++written}`;
        const file = path.join(md, "contracts", `${id}.yaml`);
        writeFile(file, `${it.body}\n`);
        written++;
      }
      log.push(`contracts: ${items.length} files`);
    },
    namespace_claims: (body) => {
      // Append to ownership.yaml (Directors run per-area in parallel and each contributes claims)
      const file = path.join(md, "ownership.yaml");
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "namespace_claims:\n";
      writeFile(file, `${existing}${body}\n`);
      written++;
      log.push("ownership.yaml (appended)");
    },
    tasks: (body) => {
      const items = splitSequenceItems(body, ["task_id"]);
      for (const it of items) {
        const id = it.idValue || `TASK-UNKNOWN-${++written}`;
        const file = path.join(md, "tasks", `${id}.yaml`);
        writeFile(file, `${it.body}\n`);
        written++;
      }
      log.push(`tasks: ${items.length} files`);
    },
    file_tree: (body) => {
      writeFile(path.join(md, "file-tree.yaml"), `file_tree:\n${body}\n`);
      written++;
      log.push("file-tree.yaml");
    },
    contract_xrefs: (body) => {
      writeFile(path.join(md, "contract-xrefs.yaml"), `contract_xrefs:\n${body}\n`);
      written++;
      log.push("contract-xrefs.yaml");
    },
    decisions_log: (body) => {
      const file = path.join(md, "deliberations", `${args.tier}-decisions-log.yaml`);
      writeFile(file, `decisions_log:\n${body}\n`);
      written++;
      log.push(`deliberations/${args.tier}-decisions-log.yaml`);
    },
    // tech_stack is a machine-readable record of the build's languages/roles.
    // The C-Suite council emits it; downstream glue-epic detection, boot_smoke
    // template selection, module-path emission, and import-graph support all
    // read it. It belongs in manifest.yaml, but manifest.yaml is otherwise not
    // created until freeze — and Gate 1 runs BEFORE freeze. So we seed
    // manifest.yaml here (status: PLANNING) with the tech_stack block. The
    // freeze step preserves this block (it reads-and-rewrites manifest.yaml).
    tech_stack: (body) => {
      const file = path.join(md, "manifest.yaml");
      let existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
      if (!/^status:/m.test(existing)) {
        existing = `status: PLANNING\n${existing}`;
      }
      // Drop any prior tech_stack block (re-run idempotency), then append fresh.
      existing = existing.replace(/^tech_stack:\n(?:[ \t]+.*\n?)*/m, "");
      const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
      writeFile(file, `${existing}${sep}tech_stack:\n${body}\n`);
      written++;
      log.push("manifest.yaml (tech_stack seeded)");
    },
  };

  for (const [key, body] of Object.entries(sections)) {
    if (!body || body.trim() === "") continue;
    const h = handlers[key];
    if (h) {
      h(body);
    } else {
      log.push(`(skipped unknown key: ${key})`);
    }
  }

  console.log(`ok:${written} files written`);
  for (const entry of log) console.log(`  ${entry}`);
}

main();
