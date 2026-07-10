#!/usr/bin/env node
/**
 * list-areas.js — List functional areas from manifest
 * Usage: node list-areas.js <functional-areas.yaml>
 * Outputs one area per line
 */
const fs = require("fs");
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("err:file not found");
  process.exit(1);
}
const content = fs.readFileSync(file, "utf-8");
const areas = content.match(/area_id:\s*"?([\w-]+)"?/g);
if (areas) {
  areas.forEach(a => {
    const match = a.match(/area_id:\s*"?([\w-]+)"?/);
    if (match) console.log(match[1]);
  });
} else {
  // Fallback: look for common area names
  const names = content.match(/name:\s*"?(\w+)"?/g);
  if (names) names.forEach(n => {
    const match = n.match(/name:\s*"?(\w+)"?/);
    if (match) console.log(match[1]);
  });
}
