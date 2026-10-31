#!/usr/bin/env node
'use strict';

/**
 * Tiny dependency-free "lint": byte-compiles every source/test/script file by
 * requiring it through Node's module loader so syntax errors fail CI, and
 * checks that no committed file leaks an obvious secret. Kept intentionally
 * minimal so the project has no heavy lint toolchain to install.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'scripts', 'tests', 'api'];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let errors = 0;

// 1. Syntax check every JS file with `node --check`.
for (const dir of DIRS) {
  for (const file of walk(path.join(ROOT, dir))) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      errors++;
      console.error(`Syntax error in ${path.relative(ROOT, file)}:\n${err.stderr || err.message}`);
    }
  }
}

// 2. Secret scan: no real TMDB/fanart keys committed (the .env is gitignored).
const SECRET_PATTERNS = [
  { re: /TMDB_API_KEY\s*[:=]\s*['"][0-9a-f]{32}['"]/i, what: 'hardcoded TMDB key' },
  { re: /api_key=[0-9a-f]{32}/i, what: 'inline TMDB api_key' },
];
for (const dir of DIRS.concat(['data'])) {
  for (const file of walk(path.join(ROOT, dir))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const { re, what } of SECRET_PATTERNS) {
      if (re.test(text)) {
        errors++;
        console.error(`Possible ${what} in ${path.relative(ROOT, file)}`);
      }
    }
  }
}

if (errors) {
  console.error(`\nLint FAILED with ${errors} issue(s).`);
  process.exit(1);
}

// 3. No-slop guard: reject emojis in the config row names and source files.
//    Keeps catalogue labels and code clean and professional.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const slopTargets = [path.join(ROOT, 'data', 'catalogue.config.json')].concat(
  DIRS.flatMap((d) => walk(path.join(ROOT, d)))
);
for (const file of slopTargets) {
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  if (EMOJI_RE.test(text)) {
    errors++;
    console.error(`Emoji / decorative character found in ${path.relative(ROOT, file)} (keep labels plain).`);
  }
}

// 4. README relative-link check: every ](./path) or ](path) local link resolves.
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) {
  const text = fs.readFileSync(readme, 'utf8');
  const linkRe = /\]\((\.\/[^)\s]+|[A-Za-z0-9_][^):\s]*\.(?:md|json|js))\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const target = m[1].split('#')[0];
    const resolved = path.resolve(ROOT, target);
    if (!fs.existsSync(resolved)) {
      errors++;
      console.error(`README links to missing file: ${target}`);
    }
  }
}

if (errors) {
  console.error(`\nLint FAILED with ${errors} issue(s).`);
  process.exit(1);
}
console.log('Lint OK.');
