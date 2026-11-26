#!/usr/bin/env node
'use strict';
/**
 * Formats the data/*.json files in the repo's house style: two-space
 * indentation, with any object or array that fits on one line kept on one
 * line ({ "id": "netflix", "title": "Netflix" }), the way the files are
 * written by hand. Run: node scripts/format-data.js [--check] [files...]
 */
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 120;

function inline(v) {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)}: ${inline(v[k])}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

const isPrimitive = (x) => x === null || typeof x !== 'object';
const isFlat = (v) => (Array.isArray(v) ? v : Object.values(v)).every((x) => isPrimitive(x) || (Array.isArray(x) && x.every(isPrimitive)));

function format(v, indent, depth, inlineDepth, mode) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const one = inline(v);
  const fits =
    mode === 'structure'
      ? (isFlat(v) && depth >= 3) || (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && isFlat(x)) && depth >= 3)
      : indent.length + one.length <= WIDTH;
  if (depth >= inlineDepth || fits || (isFlat(v) && Array.isArray(v))) return one;
  const pad = `${indent}  `;
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => pad + format(x, pad, depth + 1, inlineDepth, mode)).join(',\n')}\n${indent}]`;
  }
  const body = Object.keys(v).map((k) => `${pad}${JSON.stringify(k)}: ${format(v[k], pad, depth + 1, inlineDepth, mode)}`);
  return `{\n${body.join(',\n')}\n${indent}}`;
}

/** Depth from which nodes always stay on one line, per file. */
const INLINE_DEPTH = { 'collections.json': 4, 'catalogue.config.json': 5 };
// collections.json keeps anything that fits in WIDTH on one line; the row
// config keeps flat objects (and lists of them) on one line at any width.
const MODE = { 'catalogue.config.json': 'structure' };

function formatFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file);
  return `${format(data, '', 0, INLINE_DEPTH[name] || 4, MODE[name])}\n`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const files = args.filter((a) => a !== '--check');
  const list = files.length ? files : ['collections.json', 'catalogue.config.json'].map((f) => path.join(__dirname, '..', 'data', f));
  let bad = 0;
  for (const file of list) {
    const out = formatFile(file);
    if (check) {
      if (out !== fs.readFileSync(file, 'utf8')) {
        console.error(`not formatted: ${file}`);
        bad++;
      }
    } else fs.writeFileSync(file, out);
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { formatFile, inline };
