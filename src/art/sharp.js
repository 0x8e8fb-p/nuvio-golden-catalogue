'use strict';

/**
 * The only place in the codebase that loads sharp.
 *
 * sharp's prebuilt libvips bundles fontconfig and Pango but no fonts.conf. Without one,
 * fontconfig logs "Cannot load default config file", scans every system font folder and
 * writes a cache in the home directory (several seconds on the first text render). So
 * before sharp is required for the first time we write a tiny fonts.conf that lists only
 * the repo's assets/fonts directory, with a cache directory under the OS temp dir (the
 * only writable place on serverless hosts).
 *
 * PANGOCAIRO_BACKEND=fc makes Pango use fontconfig on macOS too. Its default CoreText
 * backend there silently ignores text.fontfile and draws a system font instead. On Linux
 * fontconfig is the only backend, so the setting is harmless and local renders match
 * production.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Absolute path of the bundled font directory. */
const FONT_DIR = path.resolve(__dirname, '..', '..', 'assets', 'fonts');

/** Absolute path of the bundled display face (SIL OFL). */
const FONT_FILE = path.join(FONT_DIR, 'BebasNeue-Regular.ttf');

/** Family name stored inside FONT_FILE. */
const FONT_FAMILY = 'Bebas Neue';

let loaded = null;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Write <tmpdir>/golden-fontconfig/fonts.conf (only when its content changed) and return
 * its path. The write goes through a temp file and a rename, so concurrent processes never
 * read a half-written config.
 * @returns {string} absolute path of fonts.conf
 */
function writeFontconfig() {
  const base = path.join(os.tmpdir(), 'golden-fontconfig');
  const cacheDir = path.join(base, 'cache');
  const file = path.join(base, 'fonts.conf');
  const xml = [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    '<fontconfig>',
    '  <!-- Only the bundled fonts. No system font directories are scanned. -->',
    `  <dir>${escapeXml(FONT_DIR)}</dir>`,
    `  <cachedir>${escapeXml(cacheDir)}</cachedir>`,
    '</fontconfig>',
    '',
  ].join('\n');
  fs.mkdirSync(cacheDir, { recursive: true });
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = null;
  }
  if (current !== xml) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, xml);
    fs.renameSync(tmp, file);
  }
  return file;
}

/**
 * Return the sharp module, preparing the font environment on the first call.
 *
 * First call: writes the fontconfig file, sets FONTCONFIG_FILE (unless the environment
 * already sets it) and PANGOCAIRO_BACKEND=fc, requires sharp and disables its operation
 * cache. Later calls return the same module.
 *
 * @returns {import('sharp')} the sharp module
 * @throws {Error} with code 'SHARP_UNAVAILABLE' when sharp cannot be loaded
 */
function getSharp() {
  if (loaded) return loaded;
  try {
    const file = writeFontconfig();
    if (!process.env.FONTCONFIG_FILE) process.env.FONTCONFIG_FILE = file;
  } catch {
    // Read-only temp dir: text still renders through text.fontfile, fontconfig just
    // falls back to its built-in defaults (slower first render).
  }
  process.env.PANGOCAIRO_BACKEND = 'fc';
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    const e = new Error(err && err.message ? err.message : String(err));
    e.code = 'SHARP_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
  sharp.cache(false);
  loaded = sharp;
  return sharp;
}

module.exports = { getSharp, FONT_FILE, FONT_FAMILY, FONT_DIR };
