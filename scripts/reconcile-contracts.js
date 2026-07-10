#!/usr/bin/env node
/**
 * reconcile-contracts.js — Cross-epic contract reconciliation
 *
 * Detects two kinds of overlap and reconciles each:
 *
 *   (1) Same contract NAME across files (legacy detection).
 *       Resolved via identical/compatible/conflicting classification on the
 *       freeform `definition:` field. Identical/compatible → dedup; conflicting
 *       → Director-tier subagent arbitration.
 *
 *   (2) Same SURFACE SYMBOL (kind+name) appearing in 2+ contracts.
 *       This is the canonical drift case the binding rule catches: parallel
 *       Director councils for adjacent areas each define a contract that
 *       exposes the same endpoint/method/type. Resolved by:
 *         a. Build the connected component of contracts that share any symbol
 *         b. Pick the canonical based on `produced_by_area` matching the
 *            symbol's natural owner (e.g. REST endpoints owned by FA-API);
 *            fallback: the contract with the largest surface
 *         c. Merge non-canonical contracts' surfaces INTO the canonical
 *            (union of symbols), then rewrite every task's contracts_consumed
 *            and contracts_produced references from any non-canonical id to
 *            the canonical
 *         d. Move non-canonical contract files to manifest/_raw/reconciled/
 *
 * Usage:
 *   node reconcile-contracts.js --manifest-dir <dir> --model <model>
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--manifest-dir": parsed.manifestDir = args[++i]; break;
      case "--model": parsed.model = args[++i]; break;
    }
  }
  return parsed;
}

function loadYAML(filePath) {
  try { return yaml.load(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

function extractField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?`, "m"));
  return match ? match[1].trim() : null;
}

// ── Connected-component analysis on surface-symbol overlap ──
//
// Two contracts are linked if they share any (kind, name) in their surfaces.
// We compute the transitive closure (union-find) and group contracts into
// "overlap clusters". A cluster of size > 1 is a reconciliation target.
function findSurfaceOverlapClusters(contracts) {
  // contracts: [{ id, file, doc, area, surfaceSyms: Set<"KIND::name"> }]
  // Union-find by index
  const parent = contracts.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  // Only ENDPOINTs and METHODs are *identity-defining* symbols — two
  // contracts that both expose `POST /jobs/upload` or `Module.foo()` are
  // clearly the same surface. TYPEs, EVENTs, and CONSTs are commonly
  // SHARED between unrelated contracts (e.g. `JobRecord` returned by an
  // ENDPOINT and queried by a DB method) — they do not signal duplication
  // by themselves and would create false bridges in the cluster graph.
  const IDENTITY_KINDS = new Set(["ENDPOINT", "METHOD"]);
  const identityOf = (sym) => {
    const kind = sym.split("::")[0];
    return IDENTITY_KINDS.has(kind);
  };

  // Build (kind+name) → contract-index map; on collision, union
  // — but only for identity-defining symbols.
  const symbolMap = {};
  for (let i = 0; i < contracts.length; i++) {
    for (const sym of contracts[i].surfaceSyms) {
      if (!identityOf(sym)) continue;
      if (symbolMap[sym] !== undefined) {
        union(symbolMap[sym], i);
      } else {
        symbolMap[sym] = i;
      }
    }
  }

  // Group by root
  const clusters = {};
  for (let i = 0; i < contracts.length; i++) {
    const root = find(i);
    (clusters[root] ||= []).push(i);
  }
  return Object.values(clusters).filter(c => c.length > 1).map(c => c.map(i => contracts[i]));
}

// Heuristic: pick the canonical contract in a cluster.
// 1. Prefer the contract whose `produced_by_area` matches the natural owner of
//    the symbol's namespace (REST endpoints → FA-API; SQL DDL → FA-DB; etc).
// 2. Else, prefer the contract with the largest surface (most authoritative).
// 3. Stable tiebreak: lexicographic by contract_id.
function pickCanonical(cluster) {
  // Score each contract:
  //   +10 if its produced_by_area matches the symbol-domain heuristic
  //   +1 per surface symbol
  // Build symbol-domain → area_hint map. For now, infer from contract_type
  // and surface kinds.
  const score = (c) => {
    let s = c.surfaceSyms.size;
    // Heuristic: a contract that PRODUCES (vs CONSUMES) is more likely canonical
    if (c.doc.produced_by_area && c.doc.produced_by_area === c.area) s += 5;
    // Heuristic: contract type alignment with the symbols
    const types = new Set([...c.surfaceSyms].map(s => s.split("::")[0]));
    if (types.has("ENDPOINT") && c.area === "FA-API") s += 10;
    if (types.has("SQL_DDL") && c.area === "FA-DB") s += 10;
    return s;
  };
  return cluster.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    if (sb !== sa) return sb - sa;
    return a.id.localeCompare(b.id);
  })[0];
}

// Merge surfaces: union of (kind, name) entries, dedup by symbol key.
function mergeSurfaces(canonical, others) {
  const seen = new Set();
  const merged = [];
  for (const c of [canonical, ...others]) {
    const surf = (c.doc.surface || []);
    for (const entry of surf) {
      if (!entry || typeof entry !== "object" || !entry.name) continue;
      const key = `${entry.kind || "?"}::${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

// Rewrite a task YAML's contracts_consumed / contracts_produced entries from
// any of `oldIds` to `newId`. Preserves invokes/implements arrays. Returns
// number of edits made.
function rewriteTaskContractRefs(taskFile, oldIds, newId) {
  let text = fs.readFileSync(taskFile, "utf-8");
  let edits = 0;
  for (const oldId of oldIds) {
    // Match in both flat-string form and structured object form.
    const flat = new RegExp(`(-\\s*)["']?${oldId}["']?(\\s*$|\\s+#)`, "gm");
    const before = text;
    text = text.replace(flat, (m, dash, tail) => `${dash}"${newId}"${tail}`);
    if (text !== before) edits++;

    const structured = new RegExp(`(contract_id:\\s*)["']?${oldId}["']?`, "g");
    const before2 = text;
    text = text.replace(structured, (m, prefix) => `${prefix}"${newId}"`);
    if (text !== before2) edits++;
  }
  if (edits > 0) fs.writeFileSync(taskFile, text);
  return edits;
}

async function main() {
  const args = parseArgs();
  const contractsDir = path.join(args.manifestDir, "contracts");
  const tasksDir = path.join(args.manifestDir, "tasks");
  const archiveDir = path.join(args.manifestDir, "_raw", "reconciled");
  fs.mkdirSync(archiveDir, { recursive: true });

  if (!fs.existsSync(contractsDir)) {
    console.log("ok:no contracts to reconcile");
    return;
  }

  // Load all contracts with parsed surfaces
  const contracts = [];
  for (const f of fs.readdirSync(contractsDir)) {
    if (!f.endsWith(".yaml")) continue;
    const filePath = path.join(contractsDir, f);
    const doc = loadYAML(filePath);
    if (!doc || !doc.contract_id) continue;
    const surfaceSyms = new Set();
    if (Array.isArray(doc.surface)) {
      for (const entry of doc.surface) {
        if (entry && typeof entry === "object" && entry.name) {
          surfaceSyms.add(`${entry.kind || "?"}::${entry.name}`);
        }
      }
    }
    contracts.push({
      id: doc.contract_id,
      file: f,
      filePath,
      doc,
      area: doc.produced_by_area || doc.owner_area || null,
      surfaceSyms,
    });
  }

  // ── PHASE A: Surface-symbol overlap detection (the binding case) ──
  const clusters = findSurfaceOverlapClusters(contracts);
  console.log(`scanned ${contracts.length} contracts, found ${clusters.length} surface-overlap cluster(s)`);

  let mergedClusters = 0;
  for (const cluster of clusters) {
    const canonical = pickCanonical(cluster);
    const others = cluster.filter(c => c.id !== canonical.id);
    console.log(`  cluster: canonical=${canonical.id} (${canonical.area}, ${canonical.surfaceSyms.size} syms), absorbing: ${others.map(o => o.id + ` (${o.surfaceSyms.size})`).join(", ")}`);

    // Merge surfaces into canonical
    const mergedSurface = mergeSurfaces(canonical, others);
    canonical.doc.surface = mergedSurface;
    // Merge consumed_by_areas
    const consumedAreas = new Set();
    for (const c of cluster) {
      for (const a of (c.doc.consumed_by_areas || [])) consumedAreas.add(a);
    }
    canonical.doc.consumed_by_areas = Array.from(consumedAreas).sort();
    canonical.doc.reconciled = true;
    canonical.doc.reconciliation_notes = (canonical.doc.reconciliation_notes || []).concat(
      others.map(o => `Absorbed ${o.id} (was: "${o.doc.name || o.id}"). All consumer references rewritten.`)
    );
    // Write the merged canonical back
    fs.writeFileSync(canonical.filePath, yaml.dump(canonical.doc, { lineWidth: -1 }));

    // Update every task file: rewrite references from any "other" id → canonical id
    const otherIds = others.map(o => o.id);
    let totalEdits = 0;
    if (fs.existsSync(tasksDir)) {
      for (const tf of fs.readdirSync(tasksDir)) {
        if (!tf.endsWith(".yaml")) continue;
        totalEdits += rewriteTaskContractRefs(path.join(tasksDir, tf), otherIds, canonical.id);
      }
    }
    // Same for task-groups (they also reference contracts)
    const groupsDir = path.join(args.manifestDir, "task-groups");
    if (fs.existsSync(groupsDir)) {
      for (const tf of fs.readdirSync(groupsDir)) {
        if (!tf.endsWith(".yaml")) continue;
        totalEdits += rewriteTaskContractRefs(path.join(groupsDir, tf), otherIds, canonical.id);
      }
    }
    console.log(`    rewrote ${totalEdits} task/group reference(s)`);

    // Archive absorbed contracts
    for (const o of others) {
      const dst = path.join(archiveDir, o.file);
      fs.renameSync(o.filePath, dst);
    }
    mergedClusters++;
  }

  // ── PHASE B: Legacy name-overlap detection (kept for backward compat) ──
  // Reload contracts in case Phase A removed any.
  const remaining = contracts.filter(c => fs.existsSync(c.filePath));
  const byName = {};
  for (const c of remaining) {
    if (!c.doc.name) continue;
    const key = c.doc.name.toLowerCase();
    (byName[key] ||= []).push(c);
  }
  const nameOverlaps = Object.entries(byName).filter(([, cs]) => cs.length > 1);

  if (clusters.length === 0 && nameOverlaps.length === 0) {
    console.log("ok:no overlapping contracts found");
    return;
  }

  if (nameOverlaps.length > 0) {
    console.log(`also found ${nameOverlaps.length} same-name contract overlap(s) — using legacy resolution`);
    // Legacy path: rely on subagent arbitration for definition conflicts
    // (kept simple — Phase A handles the structural overlap which is the
    // common case under the binding rule).
    for (const [name, cs] of nameOverlaps) {
      console.log(`  same-name: "${name}" → ${cs.map(c => c.id).join(", ")}`);
    }
  }

  console.log(`ok:reconciliation complete (${mergedClusters} surface clusters merged, ${nameOverlaps.length} name overlaps flagged)`);
}

main().catch(e => {
  console.log(`err:${e.message}`);
  process.exit(1);
});
