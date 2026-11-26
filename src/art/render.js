'use strict';

/**
 * Artwork renderer: landscape tiles, Top 10 rank tiles, collection folder covers,
 * animated folder focus loops, tilted poster-wall heroes and hero video frames for the
 * Nuvio TV app (src/art/video.js encodes the frames).
 *
 * Design rules (premium streaming look, no slop):
 * - One typeface (Bebas Neue), white or the logo's own colours.
 * - Black-to-transparent shading only: no colour gradients, glows, badges or text shadows.
 * - Safe margins of about 5% of the width, one clear focal label per image.
 * - No text in hero stills or hero video frames: Nuvio draws the folder logo on top.
 *
 * Motion rules:
 * - WebP focus loops are continuous Ken Burns motion with every frame at 100 ms, because
 *   Nuvio on iOS plays WebP frames at a fixed 100 ms. GIF loops hold and crossfade.
 * - Hero video frame 0 is the hero still, and the motion eases out and back to it, so
 *   Nuvio's hand-over between still and video (and back) is invisible.
 *
 * Robustness rules:
 * - Image inputs are Buffers (JPEG, PNG, WebP or SVG) or null. Anything that fails to
 *   decode is treated as missing, so every function always returns a valid image.
 * - Nothing here touches the network.
 *
 * Pixel work that needs exact control (shading, label compositing, crossfades) happens on
 * raw RGB buffers in JS; decoding, resizing, blurring, rotation, text and encoding are
 * done by sharp/libvips.
 */

const fs = require('node:fs');
const { getSharp, FONT_FILE, FONT_FAMILY } = require('./sharp');

/**
 * Output sizes in px, [width, height]. Poster shapes are 0.675 wide per unit of height,
 * the ratio of Nuvio's POSTER tile, because Nuvio stretches images to the tile.
 */
const SIZES = Object.freeze({
  tile: Object.freeze([960, 540]),
  rank: Object.freeze([960, 540]),
  coverLandscape: Object.freeze([640, 360]),
  coverPoster: Object.freeze([405, 600]),
  coverSquare: Object.freeze([600, 600]),
  focus: Object.freeze([416, 234]),
  focusPoster: Object.freeze([243, 360]),
  focusSquare: Object.freeze([300, 300]),
  hero: Object.freeze([1920, 1080]),
});

/** Focus loop size per folder shape (same aspect as the cover it plays over). */
const FOCUS_SIZES = Object.freeze({
  landscape: SIZES.focus,
  poster: SIZES.focusPoster,
  square: SIZES.focusSquare,
});

// ---- Palette and layout constants ------------------------------------------------------

const CANVAS_BASE = [7, 8, 11]; // #07080B
const CANVAS_LIFT = [22, 25, 34]; // #161922
const NUMERAL_FILL = '#0A0B0F';
const NUMERAL_STROKE = '#D7D9E0';
const TRACKING = 0.02; // wordmark letter spacing, in em
const LINE_GAP = 0.22; // gap between wordmark lines, as a fraction of the cap height

const TILE = { margin: 48, logoBox: [0.54, 0.3], wordBox: [0.62, 0.34], logoArea: 0.62 };
const COVER = {
  landscape: { size: SIZES.coverLandscape, logoBox: [0.62, 0.4], wordBox: [0.86, 0.34] },
  poster: { size: SIZES.coverPoster, logoBox: [0.74, 0.24], wordBox: [0.86, 0.26] },
  square: { size: SIZES.coverSquare, logoBox: [0.68, 0.34], wordBox: [0.86, 0.3] },
};
const COVER_LOGO_AREA = 0.66;
const BRAND_BLUR_AT_640 = 1.5;
// Relative luminance below which a logo pixel reads as dark on dark art (about sRGB 100).
const DARK_LOGO_L = 0.13;
const FOCUS = {
  // WebP focus loops are continuous motion at one uniform frame time. Nuvio on iOS
  // ignores WebP frame durations (ImageIO frames there all play at 100 ms), and libwebp
  // merges identical consecutive frames into one long frame, so a held still would
  // flash by on an iPhone. Instead every frame moves a little: each picture drifts and
  // zooms slowly (Ken Burns) and crossfades into the next, and the loop wraps seamlessly.
  // frames: frames per picture; fadeFrames: overlap with the next picture;
  // zoom: total zoom per picture (the source is decoded that much larger, so the
  // closest framing is 1:1 and stays sharp).
  motion: { frameMs: 100, pictures: 3, frames: 14, fadeFrames: 4, zoom: 0.08 },
  // GIF, the fallback for older TVs, keeps a still hold and a short crossfade: GIF frame
  // delays are honoured everywhere, and every changed GIF frame costs about a whole
  // picture, so motion would be several times larger.
  holdMs: 1600,
  maxPictures: 4,
  // GIF has no delta coding apart from transparent pixels, so a crossfade frame costs
  // about as much as a whole picture: one half-way frame keeps 4 pictures near 450 KB.
  gifFade: { weights: [0.5], ms: 100 },
  // Dither noise defeats GIF's LZW compression, and a fresh palette per frame keeps
  // gradients smooth without it. Pixels that barely change (label, dark areas) are
  // left transparent. Palette reuse stays at the default: looser values hand one
  // picture's palette to the next and visibly posterise it.
  gif: { effort: 1, dither: 0, interFrameMaxError: 6 },
  webp: { quality: 72, effort: 4 },
};
// Poster card in rank tiles and poster-layout title tiles: 2:3, rounded, soft shadow.
const CARD = { height: 470, radius: 12 };
const HERO = { cell: [220, 330], gap: 18, canvas: [2500, 1600], angle: -8, radius: 8, maxPosters: 40 };
// Hero video: the same wall at 1280x720, its columns gliding in turn up and down along
// the tilt by up to `amplitude` px (at video scale) and easing back, so the video starts
// and ends on the hero still. extraRows: posters above and below the visible wall for
// the columns to travel into (the still uses the same layout, so its posters sit
// exactly where the video's start).
const HERO_VIDEO = { size: [1280, 720], fps: 30, seconds: 6, amplitude: 130, extraRows: 1 };

// ---- Small helpers ----------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

// 64x64 tile of deterministic noise in [-0.5, 0.5): dither for shading so smooth dark
// gradients do not band after 8-bit rounding. Same value for the same pixel in every
// frame, so static parts of an animation stay identical.
const NOISE = (() => {
  const t = new Float32Array(4096);
  let s = 0x9e3779b9;
  for (let i = 0; i < 4096; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    t[i] = (s >>> 0) / 4294967296 - 0.5;
  }
  return t;
})();

// sRGB 8-bit to linear light.
const SRGB_TO_LINEAR = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input.length ? input : null;
  if (input instanceof Uint8Array && input.byteLength) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

// text.text is Pango markup: a bare "&" or "<" throws "invalid markup".
function escapeMarkup(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeColor(color, fallback) {
  const c = typeof color === 'string' ? color.trim() : '';
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c) || /^[a-z]{3,20}$/i.test(c) ? c : fallback;
}

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
}

// ---- Font metrics and glyph coverage (read straight from the TTF) ---------------------

let fontCache = null;

/**
 * Advance widths (em) per code point, cap height (em) and coverage of the bundled font.
 * Used to choose line breaks and sizes before rendering, and to drop characters the font
 * cannot draw (Pango would otherwise draw hex "tofu" boxes, since no other font exists).
 */
function fontInfo() {
  if (fontCache) return fontCache;
  const info = { capHeight: 0.7, advance: null };
  try {
    const b = fs.readFileSync(FONT_FILE);
    const tables = {};
    const numTables = b.readUInt16BE(4);
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      tables[b.toString('latin1', rec, rec + 4)] = b.readUInt32BE(rec + 8);
    }
    const unitsPerEm = b.readUInt16BE(tables.head + 18);
    const numberOfHMetrics = b.readUInt16BE(tables.hhea + 34);
    const os2 = tables['OS/2'];
    if (os2 !== undefined && b.readUInt16BE(os2) >= 2) {
      const cap = b.readInt16BE(os2 + 88) / unitsPerEm;
      if (cap > 0.3 && cap < 1.2) info.capHeight = cap;
    }
    const advanceOf = (glyph) => b.readUInt16BE(tables.hmtx + 4 * Math.min(glyph, numberOfHMetrics - 1)) / unitsPerEm;

    // cmap: first Unicode subtable in format 4 (BMP is enough for this font).
    const cmap = tables.cmap;
    const count = b.readUInt16BE(cmap + 2);
    let sub = -1;
    for (let i = 0; i < count && sub < 0; i++) {
      const rec = cmap + 4 + i * 8;
      const platform = b.readUInt16BE(rec);
      const offset = cmap + b.readUInt32BE(rec + 4);
      if ((platform === 0 || platform === 3) && b.readUInt16BE(offset) === 4) sub = offset;
    }
    if (sub >= 0) {
      const advance = new Map();
      const segX2 = b.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = b.readUInt16BE(ends + i * 2);
        const start = b.readUInt16BE(starts + i * 2);
        const delta = b.readInt16BE(deltas + i * 2);
        const rangeOffset = b.readUInt16BE(ranges + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            glyph = b.readUInt16BE(ranges + i * 2 + rangeOffset + (c - start) * 2);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) advance.set(c, advanceOf(glyph));
        }
      }
      if (advance.size) info.advance = advance;
    }
  } catch {
    // Keep the defaults: printable ASCII only, estimated widths.
  }
  fontCache = info;
  return info;
}

function glyphAdvance(cp) {
  const { advance } = fontInfo();
  if (advance) return advance.get(cp);
  return cp >= 0x20 && cp <= 0x7e ? 0.4 : undefined;
}

/**
 * Uppercase the text and keep only characters the font can draw. Accented letters the
 * font lacks fall back to their base letter; anything else becomes a space.
 */
function cleanLabel(text) {
  if (text === null || text === undefined) return '';
  let s = String(text).normalize('NFC').toUpperCase();
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (/\s/u.test(ch) || cp < 0x20) {
      out += ' ';
    } else if (glyphAdvance(cp) !== undefined) {
      out += ch;
    } else {
      const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      out += base && [...base].every((c) => glyphAdvance(c.codePointAt(0)) !== undefined) ? base : ' ';
    }
  }
  s = out.replace(/\s+/g, ' ').trim();
  // Separators left dangling by dropped characters (e.g. "TITLE: <unsupported>").
  s = s.replace(/^[\s:;,.|/\\\-\u2013\u2014]+/, '').replace(/[\s:;,|/\\\-\u2013\u2014]+$/, '').trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

function lineWidthEm(line) {
  let w = 0;
  let n = 0;
  for (const ch of line) {
    w += glyphAdvance(ch.codePointAt(0)) || 0.4;
    n++;
  }
  return w + TRACKING * Math.max(0, n - 1);
}

/**
 * Pick 1 or 2 lines and a font size so the text block fits boxW x boxH as large as
 * possible. Two lines must win by 12% to be used: one line reads more like a title.
 */
function layoutLabel(text, boxW, boxH, maxLines) {
  const cap = fontInfo().capHeight;
  const words = text.split(' ');
  const single = { lines: [text], fontPx: Math.min(boxW / lineWidthEm(text), boxH / cap) };
  let best = single;
  if (maxLines >= 2 && words.length > 1) {
    let two = null;
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ');
      const b = words.slice(k).join(' ');
      const wa = lineWidthEm(a);
      const wb = lineWidthEm(b);
      const fontPx = Math.min(boxW / Math.max(wa, wb), boxH / (cap * (2 + LINE_GAP)));
      const balance = Math.abs(wa - wb);
      if (!two || fontPx > two.fontPx + 0.01 || (Math.abs(fontPx - two.fontPx) <= 0.01 && balance < two.balance)) {
        two = { lines: [a, b], fontPx, balance };
      }
    }
    if (two && two.fontPx > single.fontPx * 1.12) best = two;
  }
  return best;
}

// ---- Decoding -------------------------------------------------------------------------

async function inspect(buf) {
  try {
    const meta = await getSharp()(buf).metadata();
    return meta && meta.width > 0 && meta.height > 0 ? meta : null;
  } catch {
    return null;
  }
}

// Vector input (SVG) is rasterised at the size it is needed, not at its nominal 72 dpi size.
function loadOptions(meta, scale) {
  const opts = { autoOrient: true };
  if (meta.format === 'svg') opts.density = clamp(Math.round(72 * scale), 8, 2400);
  return opts;
}

/**
 * Decode an image, cover-crop it to w x h and return raw RGB, or null when the input is
 * missing or undecodable. Transparent areas are flattened onto the dark canvas colour.
 */
async function decodeCover(input, w, h, { blur = 0, position = 'centre' } = {}) {
  const buf = asBuffer(input);
  if (!buf) return null;
  const meta = await inspect(buf);
  if (!meta) return null;
  try {
    let img = getSharp()(buf, loadOptions(meta, Math.max(w / meta.width, h / meta.height)))
      .resize(w, h, { fit: 'cover', position })
      .flatten({ background: { r: CANVAS_BASE[0], g: CANVAS_BASE[1], b: CANVAS_BASE[2] } });
    if (blur >= 0.3) img = img.blur(blur);
    const { data, info } = await img.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== w || info.height !== h || info.channels !== 3) return null;
    return data;
  } catch {
    return null;
  }
}

// ---- Shading fields -------------------------------------------------------------------
// A field holds the opacity of a black layer per pixel. Layers stack like real overlays:
// a = 1 - (1 - a1) * (1 - a2).

function newField(w, h, base = 0) {
  const a = new Float32Array(w * h);
  if (base > 0) a.fill(base);
  return { w, h, a };
}

function stackRows(field, fn) {
  const { w, h, a } = field;
  for (let y = 0; y < h; y++) {
    const v = fn(y);
    if (v <= 0) continue;
    const k = 1 - v;
    for (let p = y * w, end = p + w; p < end; p++) a[p] = 1 - (1 - a[p]) * k;
  }
}

function stackColumns(field, fn) {
  const { w, h, a } = field;
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) col[x] = 1 - clamp(fn(x), 0, 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) a[p] = 1 - (1 - a[p]) * col[x];
  }
}

function stackRadial(field, cx, cy, radius, fn) {
  const { w, h, a } = field;
  const inv = 1 / radius;
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) * inv;
    for (let x = 0, p = y * w; x < w; x++, p++) {
      const dx = (x + 0.5 - cx) * inv;
      const v = fn(Math.sqrt(dx * dx + dy * dy));
      if (v > 0) a[p] = 1 - (1 - a[p]) * (1 - v);
    }
  }
}

// ---- Overlay = shading field + one label, pre-composed once ----------------------------

/**
 * Pre-compose a black shading field and an optional RGBA label into premultiplied form:
 * out = C + frame * K. Applying it to any frame is then one multiply-add per channel,
 * and label pixels come out identical in every frame.
 */
function precompose(field, label) {
  const { w, h, a } = field;
  const K = new Float32Array(w * h);
  for (let p = 0; p < K.length; p++) K[p] = 1 - a[p];
  const C = new Float32Array(w * h * 3);
  if (label) {
    const { data, width, height, left, top } = label;
    for (let y = 0; y < height; y++) {
      const yy = y + top;
      if (yy < 0 || yy >= h) continue;
      for (let x = 0; x < width; x++) {
        const xx = x + left;
        if (xx < 0 || xx >= w) continue;
        const s = (y * width + x) * 4;
        const la = data[s + 3] / 255;
        if (la <= 0) continue;
        const p = yy * w + xx;
        const q = p * 3;
        C[q] = C[q] * (1 - la) + data[s] * la;
        C[q + 1] = C[q + 1] * (1 - la) + data[s + 1] * la;
        C[q + 2] = C[q + 2] * (1 - la) + data[s + 2] * la;
        K[p] *= 1 - la;
      }
    }
  }
  return { w, h, K, C };
}

function applyOverlay(rgb, pre, out = Buffer.allocUnsafe(rgb.length)) {
  const { w, h, K, C } = pre;
  for (let y = 0; y < h; y++) {
    const nrow = (y & 63) << 6;
    for (let x = 0, p = y * w; x < w; x++, p++) {
      const k = K[p];
      const n = NOISE[nrow | (x & 63)] + 0.5;
      const q = p * 3;
      out[q] = clamp((C[q] + rgb[q] * k + n) | 0, 0, 255);
      out[q + 1] = clamp((C[q + 1] + rgb[q + 1] * k + n) | 0, 0, 255);
      out[q + 2] = clamp((C[q + 2] + rgb[q + 2] * k + n) | 0, 0, 255);
    }
  }
  return out;
}

/** Straight-alpha RGBA over opaque RGB, in place. */
function compositeOver(dst, dw, dh, src, sw, sh, left, top, opacity = 1) {
  for (let y = 0; y < sh; y++) {
    const yy = y + top;
    if (yy < 0 || yy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const xx = x + left;
      if (xx < 0 || xx >= dw) continue;
      const s = (y * sw + x) * 4;
      const a = (src[s + 3] / 255) * opacity;
      if (a <= 0) continue;
      const d = (yy * dw + xx) * 3;
      dst[d] = (src[s] * a + dst[d] * (1 - a) + 0.5) | 0;
      dst[d + 1] = (src[s + 1] * a + dst[d + 1] * (1 - a) + 0.5) | 0;
      dst[d + 2] = (src[s + 2] * a + dst[d + 2] * (1 - a) + 0.5) | 0;
    }
  }
}

/** Darken RGB in place under a single-channel mask (0-255) scaled by opacity. */
function darkenUnderMask(dst, dw, dh, mask, mw, mh, left, top, opacity) {
  for (let y = 0; y < mh; y++) {
    const yy = y + top;
    if (yy < 0 || yy >= dh) continue;
    for (let x = 0; x < mw; x++) {
      const xx = x + left;
      if (xx < 0 || xx >= dw) continue;
      const a = (mask[y * mw + x] / 255) * opacity;
      if (a <= 0) continue;
      const d = (yy * dw + xx) * 3;
      const k = 1 - a;
      dst[d] = (dst[d] * k + 0.5) | 0;
      dst[d + 1] = (dst[d + 1] * k + 0.5) | 0;
      dst[d + 2] = (dst[d + 2] * k + 0.5) | 0;
    }
  }
}

// ---- Canvases and shapes --------------------------------------------------------------

/**
 * Near-black canvas (#07080B) with a soft radial lift toward (cx, cy) (fractions of the
 * size) that peaks at #161922. Dithered, so the falloff does not band.
 */
function darkCanvas(w, h, { cx = 0.82, cy = 0.12, radius = 0.95, strength = 1 } = {}) {
  const out = Buffer.allocUnsafe(w * h * 3);
  const r = radius * Math.hypot(w, h);
  const px = cx * w;
  const py = cy * h;
  const dr = (CANVAS_LIFT[0] - CANVAS_BASE[0]) * strength;
  const dg = (CANVAS_LIFT[1] - CANVAS_BASE[1]) * strength;
  const db = (CANVAS_LIFT[2] - CANVAS_BASE[2]) * strength;
  for (let y = 0; y < h; y++) {
    const nrow = (y & 63) << 6;
    const dy = y - py;
    for (let x = 0, q = y * w * 3; x < w; x++, q += 3) {
      const dx = x - px;
      const t = 1 - smoothstep(0, 1, Math.sqrt(dx * dx + dy * dy) / r);
      const n = NOISE[nrow | (x & 63)] + 0.5;
      out[q] = (CANVAS_BASE[0] + dr * t + n) | 0;
      out[q + 1] = (CANVAS_BASE[1] + dg * t + n) | 0;
      out[q + 2] = (CANVAS_BASE[2] + db * t + n) | 0;
    }
  }
  return out;
}

/** Anti-aliased rounded-rectangle coverage mask, 0-255. */
function roundedMask(w, h, r) {
  const m = new Uint8Array(w * h).fill(255);
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr <= 0) return m;
  const corner = Math.ceil(rr);
  for (let y = 0; y < corner; y++) {
    for (let x = 0; x < corner; x++) {
      const dx = rr - (x + 0.5);
      const dy = rr - (y + 0.5);
      if (dx <= 0 || dy <= 0) continue;
      const v = Math.round(clamp(rr - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1) * 255);
      m[y * w + x] = v;
      m[y * w + (w - 1 - x)] = v;
      m[(h - 1 - y) * w + x] = v;
      m[(h - 1 - y) * w + (w - 1 - x)] = v;
    }
  }
  return m;
}

function rgbToRgba(rgb, mask) {
  const n = mask.length;
  const out = Buffer.allocUnsafe(n * 4);
  for (let p = 0; p < n; p++) {
    out[p * 4] = rgb[p * 3];
    out[p * 4 + 1] = rgb[p * 3 + 1];
    out[p * 4 + 2] = rgb[p * 3 + 2];
    out[p * 4 + 3] = mask[p];
  }
  return out;
}

/**
 * Heavily blurred, darkened art (raw RGB, W x H) from the first input that decodes, or
 * null. The blur runs at quarter resolution and is upscaled: same look, 16x less work.
 */
async function blurredArt(inputs, W, H) {
  const qw = W / 4;
  const qh = H / 4;
  let small = null;
  for (const input of inputs) {
    small = await decodeCover(input, qw, qh, { blur: 7 });
    if (small) break;
  }
  if (!small) return null;
  const rgb = await getSharp()(small, { raw: { width: qw, height: qh, channels: 3 } })
    .resize(W, H, { kernel: 'cubic' })
    .raw()
    .toBuffer();
  const field = newField(W, H, 0.78);
  stackRadial(field, W / 2, H / 2, Math.hypot(W, H) / 2, (d) => 0.55 * smoothstep(0.35, 1.05, d));
  return applyOverlay(rgb, precompose(field, null));
}

/**
 * Draw a poster card into rgb (W x H, in place): the poster (raw RGB, width x height)
 * with rounded corners over a soft shadow. The shadow is a blurred black rectangle,
 * offset down, drawn at quarter resolution.
 */
async function drawPosterCard(rgb, W, H, poster, { left, top, width, height }) {
  const sw = W / 4;
  const sh = H / 4;
  const rect = Buffer.alloc(sw * sh);
  const rx0 = Math.round((left - 6) / 4);
  const ry0 = Math.round((top + 10) / 4);
  const rx1 = Math.round((left + width + 6) / 4);
  const ry1 = Math.round((top + height + 18) / 4);
  for (let y = Math.max(0, ry0); y < Math.min(sh, ry1); y++) rect.fill(255, y * sw + Math.max(0, rx0), y * sw + Math.min(sw, rx1));
  const shadow = await getSharp()(rect, { raw: { width: sw, height: sh, channels: 1 } })
    .blur(5)
    .resize(W, H, { kernel: 'cubic' })
    .extractChannel(0)
    .raw()
    .toBuffer();
  darkenUnderMask(rgb, W, H, shadow, W, H, 0, 0, 0.7);
  compositeOver(rgb, W, H, rgbToRgba(poster, roundedMask(width, height, CARD.radius)), width, height, left, top);
}

// ---- Logos ----------------------------------------------------------------------------

/**
 * Decode, validate, trim and (when dark) whiten a logo. Returns raw RGBA at working
 * resolution, or null when the logo is unusable as an overlay.
 */
async function prepareLogo(input, targetW = 1200, targetH = 480) {
  const buf = asBuffer(input);
  if (!buf) return null;
  const meta = await inspect(buf);
  if (!meta || !meta.hasAlpha) return null;
  let data;
  let info;
  try {
    const scale = meta.format === 'svg' ? 1.5 * Math.min(targetW / meta.width, targetH / meta.height) : 1;
    ({ data, info } = await getSharp()(buf, loadOptions(meta, scale))
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch {
    return null;
  }
  if (info.channels !== 4) return null;
  const { width: w, height: h } = info;
  const total = w * h;
  let opaque = 0;
  let visible = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a > 250) opaque++;
      if (a > 32) visible++;
      if (a > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  // An opaque box (JPEG-like logo with a solid background) looks bad as an overlay, and a
  // nearly empty image is not a logo.
  if (opaque > total * 0.98 || visible < total * 0.01 || maxX < minX) return null;

  const tw = maxX - minX + 1;
  const th = maxY - minY + 1;
  const out = Buffer.allocUnsafe(tw * th * 4);
  for (let y = 0; y < th; y++) {
    data.copy(out, y * tw * 4, ((y + minY) * w + minX) * 4, ((y + minY) * w + maxX + 1) * 4);
  }
  // Contrast on dark art, judged per pixel in linear light (WCAG relative luminance):
  // - logos with no dark part (Netflix red, Prime blue) stay as they are;
  // - dark logos without colour (Disney+ navy, black wordmarks, JioHotstar's white
  //   star on black lettering) turn fully white, the usual treatment on dark UIs;
  // - dark logos with a colourful part (Peacock's dots) get only their dark pixels
  //   lifted to white, smoothly, so the colour stays.
  let solid = 0;
  let dark = 0;
  let vivid = 0;
  for (let p = 0; p < tw * th; p++) {
    const q = p * 4;
    if (out[q + 3] > 128) {
      solid++;
      if (relLuminance(out, q) < DARK_LOGO_L) dark++;
      else if (chroma(out, q) > 60) vivid++;
    }
  }
  const darkShare = solid ? dark / solid : 0;
  const vividShare = solid ? vivid / solid : 0;
  const whitened = darkShare >= 0.08 && vividShare < 0.03;
  const lifted = darkShare >= 0.08 && !whitened;
  if (whitened) {
    for (let p = 0; p < tw * th; p++) {
      out[p * 4] = 255;
      out[p * 4 + 1] = 255;
      out[p * 4 + 2] = 255;
    }
  } else if (lifted) {
    for (let p = 0; p < tw * th; p++) {
      const q = p * 4;
      const t = 1 - smoothstep(DARK_LOGO_L * 0.6, DARK_LOGO_L * 1.6, relLuminance(out, q));
      if (t <= 0) continue;
      out[q] = Math.round(out[q] + (255 - out[q]) * t);
      out[q + 1] = Math.round(out[q + 1] + (255 - out[q + 1]) * t);
      out[q + 2] = Math.round(out[q + 2] + (255 - out[q + 2]) * t);
    }
  }
  return { data: out, width: tw, height: th, whitened, lifted, darkShare };
}

/** Relative luminance (linear, 0-1) of the RGB pixel at byte offset q. */
function relLuminance(buf, q) {
  return 0.2126 * SRGB_TO_LINEAR[buf[q]] + 0.7152 * SRGB_TO_LINEAR[buf[q + 1]] + 0.0722 * SRGB_TO_LINEAR[buf[q + 2]];
}

/** Chroma (max - min of R, G, B, 0-255) of the pixel at byte offset q. */
function chroma(buf, q) {
  return Math.max(buf[q], buf[q + 1], buf[q + 2]) - Math.min(buf[q], buf[q + 1], buf[q + 2]);
}

/**
 * Size for a prepared logo inside boxW x boxH: fit, never more than 2x enlargement, and
 * optionally cap its area (optical sizing) so wide and compact logos carry similar weight.
 */
function logoSize(prep, boxW, boxH, areaFraction = 1) {
  let scale = Math.min(boxW / prep.width, boxH / prep.height, 2);
  const area = prep.width * prep.height * scale * scale;
  const maxArea = boxW * boxH * areaFraction;
  if (area > maxArea) scale *= Math.sqrt(maxArea / area);
  return [Math.max(1, Math.round(prep.width * scale)), Math.max(1, Math.round(prep.height * scale))];
}

async function resizeRgba(prep, w, h) {
  if (w === prep.width && h === prep.height) return { data: prep.data, width: w, height: h };
  const { data, info } = await getSharp()(prep.data, { raw: { width: prep.width, height: prep.height, channels: 4 } })
    .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function fitLogo(prep, boxW, boxH, areaFraction) {
  const [w, h] = logoSize(prep, boxW, boxH, areaFraction);
  return resizeRgba(prep, w, h);
}

// ---- Text -----------------------------------------------------------------------------

let lineFactorCache = 0;

// Pango's line_height attribute scales the font's natural line height. Measure that once
// so a requested baseline-to-baseline distance can be converted into a factor.
async function naturalLineHeight() {
  if (lineFactorCache) return lineFactorCache;
  try {
    const sharp = getSharp();
    const one = await sharp({ text: { text: 'H', font: `${FONT_FAMILY}, 100`, fontfile: FONT_FILE, dpi: 72 } }).metadata();
    const two = await sharp({ text: { text: 'H\nH', font: `${FONT_FAMILY}, 100`, fontfile: FONT_FILE, dpi: 72 } }).metadata();
    const pitch = (two.height - one.height) / 100;
    lineFactorCache = pitch > 0.5 && pitch < 3 ? pitch : 1.2;
  } catch {
    lineFactorCache = 1.2;
  }
  return lineFactorCache;
}

async function renderLines(lines, fontPx, color) {
  const size = Math.max(1, Math.round(fontPx * 10) / 10);
  const tracking = Math.round(TRACKING * size * 1024);
  let attrs = `foreground="${color}" letter_spacing="${tracking}"`;
  if (lines.length > 1) {
    const pitch = fontInfo().capHeight * (1 + LINE_GAP);
    attrs += ` line_height="${(pitch / (await naturalLineHeight())).toFixed(4)}"`;
  }
  const markup = `<span ${attrs}>${lines.map(escapeMarkup).join('\n')}</span>`;
  const { data, info } = await getSharp()({
    text: { text: markup, font: `${FONT_FAMILY}, ${size}`, fontfile: FONT_FILE, rgba: true, dpi: 72, align: 'left' },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Render a cleaned label as large as possible inside boxW x boxH. Returns trimmed raw
 * RGBA, or null when there is nothing the font can draw.
 */
async function labelRgba(text, boxW, boxH, { color = '#FFFFFF', maxLines = 2 } = {}) {
  const clean = cleanLabel(text);
  const bw = Math.floor(boxW);
  const bh = Math.floor(boxH);
  if (!clean || bw < 4 || bh < 4) return null;
  const fill = safeColor(color, '#FFFFFF');
  const plan = layoutLabel(clean, bw, bh, maxLines);
  let out = await renderLines(plan.lines, plan.fontPx, fill);
  // The plan uses advance widths; correct once against the real ink box.
  const fix = Math.min(bw / out.width, bh / out.height);
  if (fix > 1.03 || fix < 1) {
    const again = await renderLines(plan.lines, plan.fontPx * Math.min(fix, 1.25) * 0.995, fill);
    if (again.width <= bw && again.height <= bh) out = again;
    else if (fix > 1) out = out.width <= bw && out.height <= bh ? out : again;
    else out = again;
  }
  if (out.width > bw || out.height > bh) {
    const s = Math.min(bw / out.width, bh / out.height);
    out = await resizeRgba(out, Math.max(1, Math.floor(out.width * s)), Math.max(1, Math.floor(out.height * s)));
  }
  return out;
}

// ---- Rank numerals --------------------------------------------------------------------

let svgTextCheck = null;

// SVG <text> goes through librsvg -> Pango -> fontconfig, which only sees fonts listed in
// fonts.conf. Compare an SVG render with a text.fontfile render (always the bundled font)
// once per process; if they differ, the host's fontconfig is not ours and the numeral is
// built from the text mask instead.
function svgTextWorks() {
  if (!svgTextCheck) {
    svgTextCheck = (async () => {
      try {
        const sharp = getSharp();
        const ref = await sharp({ text: { text: '10', font: `${FONT_FAMILY}, 200`, fontfile: FONT_FILE, dpi: 72 } }).metadata();
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><text x="20" y="250" font-family="${FONT_FAMILY}" font-size="200" fill="#fff">10</text></svg>`;
        const { info } = await sharp(Buffer.from(svg)).trim({ threshold: 1 }).raw().toBuffer({ resolveWithObject: true });
        return Math.abs(info.width - ref.width) <= 3 && Math.abs(info.height - ref.height) <= 3;
      } catch {
        return false;
      }
    })();
  }
  return svgTextCheck;
}

function inkBox(rgba, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < minX ? null : { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function cropRgba(rgba, w, box) {
  const out = Buffer.allocUnsafe(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const from = ((y + box.top) * w + box.left) * 4;
    rgba.copy(out, y * box.width * 4, from, from + box.width * 4);
  }
  return out;
}

/**
 * Outlined numeral (solid fill, light outside stroke) as trimmed raw RGBA.
 * strokePx is the visible outline width outside the glyph.
 */
async function numeralRgba(label, fontPx, strokePx, trackingEm) {
  const sharp = getSharp();
  const size = Math.round(fontPx);
  const tracking = Math.round(trackingEm * size);
  if (await svgTextWorks()) {
    const pad = Math.ceil(strokePx * 2 + size * 0.08);
    const w = Math.ceil(size * 0.62 * label.length + pad * 2);
    const h = Math.ceil(size * 1.0 + pad * 2);
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`,
      `<text x="${pad}" y="${Math.round(pad + size * 0.86)}" font-family="${FONT_FAMILY}" font-size="${size}"`,
      ` letter-spacing="${tracking}" fill="${NUMERAL_FILL}" stroke="${NUMERAL_STROKE}" stroke-width="${strokePx * 2}"`,
      ` stroke-linejoin="miter" stroke-miterlimit="4" paint-order="stroke fill">${escapeMarkup(label)}</text></svg>`,
    ].join('');
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const box = inkBox(data, info.width, info.height);
    if (box) return { data: cropRgba(data, info.width, box), width: box.width, height: box.height };
  }
  // Fallback: filled glyph mask from text input, outline = dilated mask minus the glyph.
  const markup = `<span foreground="#ffffff" letter_spacing="${tracking * 1024}">${escapeMarkup(label)}</span>`;
  const glyph = await sharp({ text: { text: markup, font: `${FONT_FAMILY}, ${size}`, fontfile: FONT_FILE, dpi: 72 } })
    .extend({ top: strokePx, bottom: strokePx, left: strokePx, right: strokePx, background: '#000000' })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: gw, height: gh } = glyph.info;
  const grown = await sharp(glyph.data, { raw: { width: gw, height: gh, channels: 1 } }).dilate(strokePx).raw().toBuffer();
  const fill = hexToRgb(NUMERAL_FILL);
  const stroke = hexToRgb(NUMERAL_STROKE);
  const out = Buffer.allocUnsafe(gw * gh * 4);
  for (let p = 0; p < gw * gh; p++) {
    const inner = glyph.data[p] / 255;
    out[p * 4] = Math.round(fill[0] * inner + stroke[0] * (1 - inner));
    out[p * 4 + 1] = Math.round(fill[1] * inner + stroke[1] * (1 - inner));
    out[p * 4 + 2] = Math.round(fill[2] * inner + stroke[2] * (1 - inner));
    out[p * 4 + 3] = Math.max(grown[p], glyph.data[p]);
  }
  return { data: out, width: gw, height: gh };
}

// ---- Encoding -------------------------------------------------------------------------

function encodeJpeg(rgb, w, h, quality) {
  return getSharp()(rgb, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality, progressive: true })
    .toBuffer();
}

async function guard(render, fallback) {
  try {
    return await render();
  } catch (err) {
    if (err && err.code === 'SHARP_UNAVAILABLE') throw err;
    return fallback();
  }
}

// ---- Public API -----------------------------------------------------------------------

/**
 * Validate and normalise a transparent logo for use as an overlay.
 *
 * Returns null for images without alpha, images that are an opaque box (more than 98% of
 * pixels with alpha above 250) and images with fewer than 1% visible pixels. Otherwise
 * trims transparent margins, turns dark logos (mean luminance below 90) white while
 * keeping their alpha, and fits the result inside maxWidth x maxHeight without enlarging
 * it more than 2x.
 *
 * @param {Buffer|null} buf PNG, WebP or SVG logo
 * @param {{maxWidth?: number, maxHeight?: number}} [options]
 * @returns {Promise<{png: Buffer, width: number, height: number}|null>}
 */
async function normalizeLogo(buf, { maxWidth = 1200, maxHeight = 480 } = {}) {
  const mw = clamp(Math.round(Number(maxWidth) || 1200), 1, 4096);
  const mh = clamp(Math.round(Number(maxHeight) || 480), 1, 4096);
  try {
    const prep = await prepareLogo(buf, mw, mh);
    if (!prep) return null;
    const fitted = await fitLogo(prep, mw, mh, 1);
    const png = await getSharp()(fitted.data, { raw: { width: fitted.width, height: fitted.height, channels: 4 } })
      .png()
      .toBuffer();
    return { png, width: fitted.width, height: fitted.height };
  } catch (err) {
    if (err && err.code === 'SHARP_UNAVAILABLE') throw err;
    return null;
  }
}

/**
 * Render text as an uppercase Bebas Neue wordmark on a transparent background, trimmed
 * to the ink. Letter spacing is 2% of the font size. The text is set as large as fits
 * maxWidth x height, on one line or, when that is clearly larger, two lines. Characters
 * the font cannot draw are dropped; with nothing left a 1x1 transparent PNG is returned.
 *
 * @param {string} text
 * @param {{height?: number, maxWidth?: number, color?: string}} [options] height is the
 *   maximum height of the block in px (the cap height for one line)
 * @returns {Promise<Buffer>} PNG
 */
async function renderWordmark(text, { height = 200, maxWidth = 1400, color = '#FFFFFF' } = {}) {
  const sharp = getSharp();
  const bh = clamp(Math.round(Number(height) || 200), 4, 2000);
  const bw = clamp(Math.round(Number(maxWidth) || 1400), 4, 4000);
  const empty = () =>
    sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  return guard(async () => {
    const label = await labelRgba(text, bw, bh, { color });
    if (!label) return empty();
    return sharp(label.data, { raw: { width: label.width, height: label.height, channels: 4 } }).png().toBuffer();
  }, empty);
}

function tilePool(W, H) {
  const field = newField(W, H);
  // Dark pool anchored at the bottom-left corner, fading out before the upper right.
  stackRadial(field, 0, H, W * 0.8, (d) => 0.92 * (1 - smoothstep(0.15, 1, d)));
  // Soft floor along the bottom edge, under the label baseline.
  stackRows(field, (y) => 0.55 * smoothstep(H * 0.6, H, y));
  return field;
}

/**
 * Poster layout for a title tile without a backdrop: the poster blurred and darkened as
 * the background, the poster itself as a card on the right, and the logo or wordmark
 * bottom-left, ending a margin short of the card. Raw RGB, or null when the poster
 * does not decode.
 */
async function posterTileRgb(poster, prep, title, W, H) {
  const ph = CARD.height;
  const pw = Math.round((ph * 2) / 3);
  const card = { left: W - TILE.margin - pw, top: Math.round((H - ph) / 2), width: pw, height: ph };
  const [pRgb, bg] = await Promise.all([decodeCover(poster, pw, ph), blurredArt([poster], W, H)]);
  if (!pRgb) return null;
  const rgb = bg || darkCanvas(W, H);
  await drawPosterCard(rgb, W, H, pRgb, card);
  const room = card.left - 2 * TILE.margin;
  const label = prep
    ? await fitLogo(prep, Math.min(W * TILE.logoBox[0], room), H * TILE.logoBox[1], TILE.logoArea)
    : await labelRgba(title, Math.min(W * TILE.wordBox[0], room), H * TILE.wordBox[1]);
  // Drawn last, so the card's shadow never darkens it.
  if (label) compositeOver(rgb, W, H, label.data, label.width, label.height, TILE.margin, H - TILE.margin - label.height);
  return rgb;
}

/**
 * Landscape title tile (960x540 JPEG): backdrop with a bottom-left dark pool and the
 * title's logo, or its wordmark when there is no usable logo, anchored bottom-left.
 * Without a usable backdrop the poster stands in: blurred and darkened as the
 * background, and drawn sharp as a rounded card on the right, with the label to its
 * left. With neither, the label sits on the dark canvas.
 *
 * @param {{backdrop?: Buffer|null, poster?: Buffer|null, logo?: Buffer|null, title?: string}} [input]
 * @returns {Promise<Buffer>} JPEG
 */
async function renderTile({ backdrop, poster, logo, title } = {}) {
  const [W, H] = SIZES.tile;
  return guard(
    async () => {
      const [bg, prep] = await Promise.all([decodeCover(backdrop, W, H), prepareLogo(logo)]);
      if (!bg) {
        const posterLayout = await posterTileRgb(poster, prep, title, W, H);
        if (posterLayout) return encodeJpeg(posterLayout, W, H, 82);
      }
      const rgb = bg || darkCanvas(W, H);
      let label = null;
      if (prep) {
        label = await fitLogo(prep, W * TILE.logoBox[0], H * TILE.logoBox[1], TILE.logoArea);
      } else {
        label = await labelRgba(title, W * TILE.wordBox[0], H * TILE.wordBox[1]);
      }
      if (label) {
        label.left = TILE.margin;
        label.top = H - TILE.margin - label.height;
      }
      const out = applyOverlay(rgb, precompose(tilePool(W, H), label));
      return encodeJpeg(out, W, H, 82);
    },
    () => encodeJpeg(darkCanvas(W, H), W, H, 82),
  );
}

/**
 * Top 10 tile (960x540 JPEG): blurred, darkened art; a giant outlined Bebas Neue
 * numeral on the left; the poster (2:3, rounded, soft shadow) slightly overlapping it.
 *
 * @param {{rank?: number, poster?: Buffer|null, backdrop?: Buffer|null}} [input]
 * @returns {Promise<Buffer>} JPEG
 */
async function renderRankTile({ rank, poster, backdrop } = {}) {
  const [W, H] = SIZES.rank;
  return guard(
    async () => {
      const n = Number(rank);
      const label = Number.isFinite(n) && n >= 1 && n < 100 ? String(Math.floor(n)) : '';
      const rgb = (await blurredArt([backdrop, poster], W, H)) || darkCanvas(W, H);

      // Poster: real poster, else a 2:3 centre crop of the backdrop.
      const ph = CARD.height;
      const pw = Math.round((ph * 2) / 3);
      const pTop = Math.round((H - ph) / 2);
      const pLeft = Math.round(W * 0.46);
      let pRgb = await decodeCover(poster, pw, ph);
      if (!pRgb) pRgb = await decodeCover(backdrop, pw, ph);

      // Numeral: about 92% of the height, right edge tucked under the poster's left edge.
      if (label) {
        const stroke = 8;
        const inkH = Math.round(H * 0.92);
        const cap = fontInfo().capHeight;
        const two = label.length > 1;
        let fontPx = (inkH - 2 * stroke) / (cap * 1.03);
        let num = await numeralRgba(label, fontPx, stroke, two ? -0.04 : 0);
        const minLeft = Math.round(W * 0.05);
        const overlap = two ? Math.round(W * 0.065) : Math.round(W * 0.02);
        const right = pRgb ? pLeft + overlap : Math.round(W / 2 + num.width / 2);
        if (right - num.width < minLeft) {
          fontPx *= (right - minLeft) / num.width;
          num = await numeralRgba(label, fontPx, stroke, two ? -0.04 : 0);
        }
        const nLeft = pRgb ? right - num.width : Math.round((W - num.width) / 2);
        const nTop = Math.round((H - num.height) / 2);
        compositeOver(rgb, W, H, num.data, num.width, num.height, nLeft, nTop);
      }

      if (pRgb) await drawPosterCard(rgb, W, H, pRgb, { left: pLeft, top: pTop, width: pw, height: ph });
      return encodeJpeg(rgb, W, H, 82);
    },
    () => encodeJpeg(darkCanvas(SIZES.rank[0], SIZES.rank[1]), SIZES.rank[0], SIZES.rank[1], 82),
  );
}

/**
 * Shared cover overlay for a shape at any pixel size, so a 416x234 focus frame is the
 * landscape cover at a smaller scale. Brand mode (a usable logo, or a brand folder
 * whose logo is unusable): darkening, gentle vignette, centred logo or wordmark.
 * Category mode: bottom gradient and a bottom-left wordmark.
 */
async function coverOverlay(shape, W, H, prep, wordmark, brand = Boolean(prep), decorate = null) {
  const spec = COVER[shape] || COVER.landscape;
  if (brand) {
    const field = newField(W, H, 0.64);
    stackRadial(field, W / 2, H / 2, Math.hypot(W, H) / 2, (d) => 0.45 * smoothstep(0.4, 1.1, d));
    if (decorate) decorate(field);
    const mark = prep
      ? await fitLogo(prep, W * spec.logoBox[0], H * spec.logoBox[1], COVER_LOGO_AREA)
      : await labelRgba(wordmark, W * spec.logoBox[0], H * spec.logoBox[1]);
    if (mark) {
      mark.left = Math.round((W - mark.width) / 2);
      // Optical centre: a touch above the geometric centre.
      mark.top = Math.round((H - mark.height) / 2 - H * 0.02);
    }
    return precompose(field, mark);
  }
  const field = newField(W, H);
  stackRows(field, (y) => 0.88 * smoothstep(H * 0.5, H, y + 0.5));
  if (decorate) decorate(field);
  const margin = Math.round(W * 0.06);
  const label = await labelRgba(wordmark, W * spec.wordBox[0], H * spec.wordBox[1]);
  if (label) {
    label.left = margin;
    label.top = H - margin - label.height;
  }
  return precompose(field, label);
}

function coverCanvas(W, H, brand) {
  return brand
    ? darkCanvas(W, H, { cx: 0.5, cy: 0.38, radius: 0.7, strength: 1.4 })
    : darkCanvas(W, H, { cx: 0.8, cy: 0.15, radius: 0.9, strength: 1.2 });
}

/**
 * Collection folder cover (JPEG, exact size per shape, since Nuvio stretches covers to
 * the tile). Brand mode when the logo is usable, or when `brand` is set (a streaming
 * service or studio whose logo is unusable gets its name centred the same way);
 * otherwise category mode with the wordmark.
 *
 * @param {{shape?: 'landscape'|'poster'|'square', backdrop?: Buffer|null, logo?: Buffer|null,
 *   wordmark?: string, brand?: boolean}} [input]
 * @returns {Promise<Buffer>} JPEG: 640x360, 405x600 or 600x600
 */
async function renderFolderCover({ shape, backdrop, logo, wordmark, brand: brandFolder = false } = {}) {
  const key = COVER[shape] ? shape : 'landscape';
  const [W, H] = COVER[key].size;
  return guard(
    async () => {
      const prep = await prepareLogo(logo);
      const brand = Boolean(prep) || Boolean(brandFolder);
      const bg = await decodeCover(backdrop, W, H, { blur: brand ? BRAND_BLUR_AT_640 : 0 });
      const rgb = bg || coverCanvas(W, H, brand);
      const pre = await coverOverlay(key, W, H, prep, wordmark, brand);
      return encodeJpeg(applyOverlay(rgb, pre), W, H, 84);
    },
    () => encodeJpeg(coverCanvas(W, H, false), W, H, 84),
  );
}

function mixInto(out, a, b, t) {
  const wb = Math.round(t * 256);
  const wa = 256 - wb;
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * wa + b[i] * wb + 128) >> 8;
  return out;
}

function encodeFrames(frames, delays, W, H, format) {
  const sharp = getSharp();
  const single = frames.length === 1;
  const img = sharp(single ? frames[0] : Buffer.concat(frames), {
    raw: single ? { width: W, height: H, channels: 3 } : { width: W, height: H * frames.length, channels: 3, pageHeight: H },
  });
  if (format === 'webp') return img.webp(single ? FOCUS.webp : { ...FOCUS.webp, delay: delays, loop: 0 }).toBuffer();
  return img.gif(single ? FOCUS.gif : { ...FOCUS.gif, delay: delays, loop: 0 }).toBuffer();
}

/**
 * One Ken Burns view of a picture: the window of `src` (SW x SH RGB) at zoom `z`
 * (1 shows the whole source, SW / W shows it at 1:1) whose position is `fx`, `fy`
 * in [0, 1] of the free travel, resampled bilinearly to W x H.
 */
function kenBurnsView(src, SW, SH, W, H, z, fx, fy, out) {
  const ww = SW / z;
  const wh = SH / z;
  const x0 = (SW - ww) * clamp(fx, 0, 1);
  const y0 = (SH - wh) * clamp(fy, 0, 1);
  const sx = ww / W;
  const sy = wh / H;
  const xi = new Int32Array(W);
  const xw = new Uint16Array(W);
  for (let x = 0; x < W; x++) {
    const f = clamp(x0 + (x + 0.5) * sx - 0.5, 0, SW - 1.001);
    xi[x] = Math.floor(f);
    xw[x] = Math.round((f - xi[x]) * 256);
  }
  for (let y = 0; y < H; y++) {
    const f = clamp(y0 + (y + 0.5) * sy - 0.5, 0, SH - 1.001);
    const iy = Math.floor(f);
    const wy = Math.round((f - iy) * 256);
    const r0 = iy * SW * 3;
    const r1 = r0 + SW * 3;
    let q = y * W * 3;
    for (let x = 0; x < W; x++) {
      const a = r0 + xi[x] * 3;
      const b = r1 + xi[x] * 3;
      const wx = xw[x];
      for (let c = 0; c < 3; c++, q++) {
        const top = src[a + c] * (256 - wx) + src[a + 3 + c] * wx;
        const bot = src[b + c] * (256 - wx) + src[b + 3 + c] * wx;
        out[q] = (top * (256 - wy) + bot * wy + 32768) >> 16;
      }
    }
  }
  return out;
}

// Camera paths, one per picture in turn: zoom from, zoom to (as a fraction of the
// picture's zoom range), and the window position from and to.
const KEN_BURNS = [
  { z: [0, 1], x: [0.2, 0.8], y: [0.5, 0.5] },
  { z: [1, 0], x: [0.8, 0.3], y: [0.3, 0.7] },
  { z: [0, 1], x: [0.5, 0.5], y: [0.75, 0.25] },
  { z: [1, 0], x: [0.3, 0.7], y: [0.6, 0.4] },
];

/**
 * Frames of the motion loop (WebP): `stills` are sources decoded at SW x SH.
 * Picture j owns `frames` frames and stays visible for `fadeFrames` more while the
 * next picture fades in over it, so frame 0 is already a blend of the last picture
 * and the first: the loop has no seam. One picture zooms in and out again instead.
 */
function motionFrames(stills, SW, SH, W, H, pre) {
  const { frames: per, fadeFrames, zoom } = FOCUS.motion;
  const P = stills.length;
  const span = per + fadeFrames;
  const zMax = 1 + zoom;
  const a = Buffer.allocUnsafe(W * H * 3);
  const b = Buffer.allocUnsafe(W * H * 3);
  const view = (j, t, out) => {
    const u = t / (span - 1);
    if (P === 1) {
      const z = 1 + (zMax - 1) * (1 - Math.cos(2 * Math.PI * (t / per))) * 0.5;
      return kenBurnsView(stills[0], SW, SH, W, H, z, 0.5, 0.5, out);
    }
    const path = KEN_BURNS[j % KEN_BURNS.length];
    const lerp = ([from, to]) => from + (to - from) * u;
    return kenBurnsView(stills[j], SW, SH, W, H, 1 + (zMax - 1) * lerp(path.z), lerp(path.x), lerp(path.y), out);
  };
  const out = [];
  const total = P === 1 ? per * 2 : P * per;
  for (let f = 0; f < total; f++) {
    if (P === 1) {
      out.push(applyOverlay(view(0, f / 2, a), pre));
      continue;
    }
    const j = Math.floor(f / per);
    const k = f % per;
    view(j, k, a);
    if (k < fadeFrames) {
      // The previous picture, in its overlap frames, under the incoming one.
      view((j + P - 1) % P, per + k, b);
      mixInto(a, b, a, smoothstep(0, 1, (k + 1) / (fadeFrames + 1)));
    }
    out.push(applyOverlay(a, pre));
  }
  return out;
}

/**
 * Animated focus loop for a folder (WebP or GIF, loops forever), at the same aspect
 * as the folder's cover so Nuvio can stretch it over the tile without distortion:
 * landscape 416x234, poster 243x360, square 300x300, under the same overlay as the
 * cover, composed on every frame so the label stays perfectly still.
 *
 * WebP: up to 3 backdrops in continuous Ken Burns motion with eased crossfades, every
 * frame 100 ms (about 4 s per loop), so it plays the same on Android and on iOS. One
 * backdrop breathes (a slow zoom in and out).
 * GIF, the fallback for older TVs: up to 4 backdrops, each held 1600 ms, with one
 * 100 ms half-way frame between them, since every GIF frame costs about a whole picture.
 * The last picture fades back into the first. Without backdrops a single static frame
 * is returned (one for GIF too).
 *
 * @param {{backdrops?: Array<Buffer|null>, logo?: Buffer|null, wordmark?: string,
 *   format?: 'gif'|'webp', shape?: 'landscape'|'poster'|'square', brand?: boolean}} [input]
 * @returns {Promise<Buffer>} GIF or WebP
 */
async function renderFolderFocus({ backdrops, logo, wordmark, format = 'gif', shape = 'landscape', brand: brandFolder = false } = {}) {
  const key = FOCUS_SIZES[shape] ? shape : 'landscape';
  const [W, H] = FOCUS_SIZES[key];
  const fmt = format === 'webp' ? 'webp' : 'gif';
  return guard(
    async () => {
      const prep = await prepareLogo(logo);
      const brand = Boolean(prep) || Boolean(brandFolder);
      const blur = brand ? (BRAND_BLUR_AT_640 * W) / SIZES.coverLandscape[0] : 0;
      const list = (Array.isArray(backdrops) ? backdrops : backdrops ? [backdrops] : []).filter(Boolean);
      const want = fmt === 'webp' ? FOCUS.motion.pictures : FOCUS.maxPictures;
      // Motion needs room to move: sources are decoded larger by the zoom range.
      const scale = fmt === 'webp' ? 1 + FOCUS.motion.zoom : 1;
      const SW = Math.ceil(W * scale);
      const SH = Math.ceil(H * scale);
      const stills = [];
      for (let i = 0; i < list.length && stills.length < want; i += want) {
        const batch = await Promise.all(list.slice(i, i + want).map((b) => decodeCover(b, SW, SH, { blur: blur * scale })));
        for (const s of batch) if (s && stills.length < want) stills.push(s);
      }
      const pre = await coverOverlay(key, W, H, prep, wordmark, brand);
      if (fmt === 'webp' && stills.length) {
        const frames = motionFrames(stills, SW, SH, W, H, pre);
        return encodeFrames(frames, frames.map(() => FOCUS.motion.frameMs), W, H, fmt);
      }
      if (stills.length < 2) {
        const still = applyOverlay(stills[0] || coverCanvas(W, H, brand), pre);
        return encodeFrames([still], null, W, H, fmt);
      }
      const frames = [];
      const delays = [];
      const mix = Buffer.allocUnsafe(stills[0].length);
      stills.forEach((a, i) => {
        const b = stills[(i + 1) % stills.length];
        frames.push(applyOverlay(a, pre));
        delays.push(FOCUS.holdMs);
        for (const t of FOCUS.gifFade.weights) {
          frames.push(applyOverlay(mixInto(mix, a, b, t), pre));
          delays.push(FOCUS.gifFade.ms);
        }
      });
      return encodeFrames(frames, delays, W, H, fmt);
    },
    () => encodeFrames([coverCanvas(W, H, false)], null, W, H, fmt),
  );
}

// Fill the wall in reading order, never repeating the left, upper-left, upper or
// upper-right neighbour when there are enough posters to avoid it.
function wallOrder(rows, cols, n) {
  const grid = [];
  let next = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const avoid = new Set();
      if (c > 0) avoid.add(grid[r * cols + c - 1]);
      if (r > 0) {
        avoid.add(grid[(r - 1) * cols + c]);
        if (c > 0) avoid.add(grid[(r - 1) * cols + c - 1]);
        if (c < cols - 1) avoid.add(grid[(r - 1) * cols + c + 1]);
      }
      let pick = next % n;
      for (let k = 0; k < n && avoid.has(pick) && avoid.size < n; k++) pick = (pick + 1) % n;
      grid.push(pick);
      next = pick + 1;
    }
  }
  return grid;
}

/**
 * Geometry of the hero poster wall at a scale of the 1920x1080 hero. Column and row
 * counts always come from the full-size wall, so the still and the 1280x720 video
 * place every poster in the same spot.
 */
function heroGeometry(scale = 1) {
  const [cw0, ch0] = HERO.cell;
  const pitch0X = cw0 + HERO.gap;
  const pitch0Y = ch0 + HERO.gap;
  const cols = Math.ceil((HERO.canvas[0] + HERO.gap) / pitch0X) + 1;
  const rows = Math.ceil((HERO.canvas[1] + HERO.gap) / pitch0Y) + 1;
  const r = (v) => Math.round(v * scale);
  const cell = [r(cw0), r(ch0)];
  const gap = r(HERO.gap);
  const canvas = [r(HERO.canvas[0]), r(HERO.canvas[1])];
  const pitchX = cell[0] + gap;
  const pitchY = cell[1] + gap;
  const extra = HERO_VIDEO.extraRows;
  return {
    cell, gap, canvas, cols, rows, pitchX, pitchY, extra,
    radius: Math.max(2, r(HERO.radius)),
    // The wall strip holds every column in full, with `extra` rows above and below.
    strip: [cols * pitchX, (rows + 2 * extra) * pitchY],
    // Where the visible canvas sits in the strip (the wall is centred on the canvas).
    view: [
      Math.round((cols * pitchX - gap - canvas[0]) / 2),
      extra * pitchY + Math.round((rows * pitchY - gap - canvas[1]) / 2),
    ],
  };
}

/** Raw RGB strip of the poster wall for a geometry: columns side by side, unrotated. */
async function heroStrip(posters, g) {
  const [cw, ch] = g.cell;
  const list = (Array.isArray(posters) ? posters : posters ? [posters] : []).slice(0, HERO.maxPosters);
  const cells = (await Promise.all(list.map((p) => decodeCover(p, cw, ch)))).filter(Boolean);
  if (!cells.length) return null;
  const [SW, SH] = g.strip;
  const strip = Buffer.allocUnsafe(SW * SH * 3);
  for (let p = 0; p < SW * SH; p++) {
    strip[p * 3] = CANVAS_BASE[0];
    strip[p * 3 + 1] = CANVAS_BASE[1];
    strip[p * 3 + 2] = CANVAS_BASE[2];
  }
  const corner = roundedMask(cw, ch, g.radius);
  const rounded = cells.map((c) => rgbToRgba(c, corner));
  const rows = g.rows + 2 * g.extra;
  const order = wallOrder(rows, g.cols, rounded.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      compositeOver(strip, SW, SH, rounded[order[r * g.cols + c]], cw, ch, c * g.pitchX, r * g.pitchY);
    }
  }
  return strip;
}

/** The hero's black shading at W x H: a strong left gradient and a bottom gradient. */
function heroShadeField(W, H) {
  const field = newField(W, H, 0.45);
  stackColumns(field, (x) => 0.92 * (1 - smoothstep(0, W * 0.55, x + 0.5)));
  stackRows(field, (y) => 0.8 * smoothstep(H * 0.45, H, y + 0.5));
  return field;
}

/** Crop of a rotated canvas that fills W x H, centred. */
function rotatedCrop(CW, CH, W, H) {
  const rad = (Math.abs(HERO.angle) * Math.PI) / 180;
  const rw = Math.floor(CW * Math.cos(rad) + CH * Math.sin(rad));
  const rh = Math.floor(CW * Math.sin(rad) + CH * Math.cos(rad));
  return { left: Math.floor((rw - W) / 2), top: Math.floor((rh - H) / 2), width: W, height: H };
}

/**
 * Folder hero backdrop (1920x1080 JPEG): a wall of posters tilted by -8 degrees, darkened,
 * with a strong left gradient and a bottom gradient, since Nuvio draws its own text on
 * the left. No text is baked in. The wall is the first frame of the hero video.
 *
 * @param {{posters?: Array<Buffer|null>}} [input]
 * @returns {Promise<Buffer>} JPEG
 */
async function renderFolderHero({ posters } = {}) {
  const [W, H] = SIZES.hero;
  const shade = (rgb) => applyOverlay(rgb, precompose(heroShadeField(W, H), null));
  return guard(
    async () => {
      const g = heroGeometry(1);
      const strip = await heroStrip(posters, g);
      if (!strip) return encodeJpeg(shade(darkCanvas(W, H)), W, H, 80);
      const [CW, CH] = g.canvas;
      const bg = { r: CANVAS_BASE[0], g: CANVAS_BASE[1], b: CANVAS_BASE[2] };
      const rgb = await getSharp()(strip, { raw: { width: g.strip[0], height: g.strip[1], channels: 3 } })
        .extract({ left: g.view[0], top: g.view[1], width: CW, height: CH })
        .rotate(HERO.angle, { background: bg })
        .extract(rotatedCrop(CW, CH, W, H))
        .raw()
        .toBuffer();
      return encodeJpeg(shade(rgb), W, H, 80);
    },
    () => encodeJpeg(shade(darkCanvas(W, H)), W, H, 80),
  );
}

/**
 * The hero video as raw RGB frames, drawn so the video matches the still.
 *
 * Rotating every frame is what makes such a video expensive, so it is never done:
 * each poster column of the wall is cut out as a band (with half the gap on each side)
 * and rotated once. A column moves along its own tilted axis, so the boundaries
 * between bands stay put on screen, and every output row is a run of plain copies,
 * one per band, from the rotated bands at that frame's offsets. Offsets are whole
 * pixels, so posters stay crisp and never shimmer.
 *
 * Returns null when no poster could be decoded (no video is worth making then).
 * @param {{posters?: Array<Buffer|null>}} [input]
 * @returns {Promise<null|{width: number, height: number, fps: number, count: number,
 *   frame: (n: number) => Buffer, shade: Buffer}>} frame(n) reuses one buffer; shade
 *   is the hero's shading as a black RGBA PNG, laid over every frame by the encoder
 */
async function heroVideoFrames({ posters } = {}) {
  const sharp = getSharp();
  const [W, H] = HERO_VIDEO.size;
  const { fps, seconds, amplitude } = HERO_VIDEO;
  const g = heroGeometry(W / SIZES.hero[0]);
  const strip = await heroStrip(posters, g);
  if (!strip) return null;
  const [SW, SH] = g.strip;
  const [CW, CH] = g.canvas;
  const phi = (HERO.angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const bg = { r: CANVAS_BASE[0], g: CANVAS_BASE[1], b: CANVAS_BASE[2] };
  const half = g.gap / 2;
  const margin = 4;

  // Bands: column c spans strip x in [c * pitchX - gap / 2, c * pitchX + cell + gap / 2).
  const bands = await Promise.all(
    Array.from({ length: g.cols }, async (_, c) => {
      const x0 = Math.floor(c * g.pitchX - half) - margin;
      const bw = g.pitchX + 2 * margin + 1;
      const band = Buffer.allocUnsafe(bw * SH * 3);
      for (let p = 0; p < bw * SH; p++) {
        band[p * 3] = CANVAS_BASE[0];
        band[p * 3 + 1] = CANVAS_BASE[1];
        band[p * 3 + 2] = CANVAS_BASE[2];
      }
      const from = Math.max(0, x0);
      const to = Math.min(SW, x0 + bw);
      if (to > from) {
        for (let y = 0; y < SH; y++) strip.copy(band, (y * bw + (from - x0)) * 3, (y * SW + from) * 3, (y * SW + to) * 3);
      }
      const { data, info } = await sharp(band, { raw: { width: bw, height: SH, channels: 3 } })
        .rotate(HERO.angle, { background: bg })
        .raw()
        .toBuffer({ resolveWithObject: true });
      // The band's centre, in canvas coordinates of the still (before any motion).
      return { data, w: info.width, h: info.height, cx: x0 + bw / 2 - g.view[0], cy: SH / 2 - g.view[1], dir: c % 2 ? 1 : -1 };
    })
  );

  // Screen position of a canvas point: rotate about the canvas centre, centre on screen.
  const toScreen = (x, y) => {
    const dx = x - CW / 2;
    const dy = y - CH / 2;
    return [W / 2 + cos * dx - sin * dy, H / 2 + sin * dx + cos * dy];
  };
  // Band boundaries per row: the screen x where the line canvas-x = u crosses row Y.
  const bounds = new Int32Array(H * (g.cols + 1));
  for (let Y = 0; Y < H; Y++) {
    for (let c = 0; c <= g.cols; c++) {
      const u = c * g.pitchX - half - g.view[0];
      const X = W / 2 + (u - CW / 2 - sin * (Y - H / 2)) / cos;
      bounds[Y * (g.cols + 1) + c] = clamp(Math.ceil(X - 0.5), 0, W);
    }
  }

  const count = fps * seconds;
  const out = Buffer.allocUnsafe(W * H * 3);
  const frame = (n) => {
    // Eased out and back: still at the start, fastest half way, still again at the end.
    const o = (amplitude * (1 - Math.cos((2 * Math.PI * n) / count))) / 2;
    const offs = bands.map((b) => {
      // The band's content moves along its column by -dir * o canvas px.
      const [sx, sy] = toScreen(b.cx, b.cy - b.dir * o);
      return [Math.round(sx - b.w / 2), Math.round(sy - b.h / 2)];
    });
    for (let Y = 0; Y < H; Y++) {
      const row = Y * W * 3;
      let X = 0;
      for (let c = 0; c < g.cols; c++) {
        const x1 = bounds[Y * (g.cols + 1) + c + 1];
        if (x1 <= X) continue;
        const b = bands[c];
        const [ox, oy] = offs[c];
        const by = Y - oy;
        const bx0 = X - ox;
        const bx1 = x1 - ox;
        if (by >= 0 && by < b.h && bx0 >= 0 && bx1 <= b.w) {
          b.data.copy(out, row + X * 3, (by * b.w + bx0) * 3, (by * b.w + bx1) * 3);
        } else {
          for (let x = X; x < x1; x++) {
            const bx = x - ox;
            const q = row + x * 3;
            if (by >= 0 && by < b.h && bx >= 0 && bx < b.w) {
              const s2 = (by * b.w + bx) * 3;
              out[q] = b.data[s2];
              out[q + 1] = b.data[s2 + 1];
              out[q + 2] = b.data[s2 + 2];
            } else {
              out[q] = CANVAS_BASE[0];
              out[q + 1] = CANVAS_BASE[1];
              out[q + 2] = CANVAS_BASE[2];
            }
          }
        }
        X = x1;
      }
      for (let x = X; x < W; x++) {
        out[row + x * 3] = CANVAS_BASE[0];
        out[row + x * 3 + 1] = CANVAS_BASE[1];
        out[row + x * 3 + 2] = CANVAS_BASE[2];
      }
    }
    return out;
  };

  const field = heroShadeField(W, H);
  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) rgba[p * 4 + 3] = Math.round(clamp(field.a[p], 0, 1) * 255);
  const shade = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  return { width: W, height: H, fps, count, frame, shade };
}

module.exports = {
  SIZES,
  FOCUS_SIZES,
  normalizeLogo,
  renderWordmark,
  renderTile,
  renderRankTile,
  renderFolderCover,
  renderFolderFocus,
  renderFolderHero,
  heroVideoFrames,
  HERO_VIDEO,
  // Building blocks for motion.js (signature motion).
  _internals: {
    COVER,
    FOCUS,
    BRAND_BLUR_AT_640,
    CANVAS_BASE,
    NOISE,
    clamp,
    smoothstep,
    asBuffer,
    inspect,
    loadOptions,
    newField,
    stackRows,
    stackColumns,
    stackRadial,
    precompose,
    applyOverlay,
    darkCanvas,
    coverCanvas,
    coverOverlay,
    prepareLogo,
    encodeFrames,
    encodeJpeg,
    guard,
    kenBurnsView,
    heroShadeField,
  },
};
