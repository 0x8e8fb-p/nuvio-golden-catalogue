'use strict';
/**
 * Signature motion: every folder animates in its own way.
 *
 * A folder belongs to a motion family (a light beam sweeping the Spotlight, a
 * broadcast glitch for streaming services, a film reel pulling down for Indian
 * cinema, lightning for horror, a holographic scan for science fiction, an iris
 * for fantasy, venetian blinds for crime, a split-flap board for studios, ink
 * bleeding for anime, ...), and a seed taken from the folder's key varies the
 * family's angles, directions, centres, counts and camera paths, so no two
 * tiles move alike.
 *
 * One timeline drives every format:
 * - the cover is frame 0 of the focus loop, at the cover's size;
 * - WebP focus loops: P pictures x FOCUS_PER frames at 100 ms (uniform, for
 *   iOS), each picture drifting under its camera and handing over to the next
 *   with the family's transition; the last hands back to frame 0 (no seam);
 * - GIF focus loops: holds plus two transition frames per hand-over;
 * - the hero still (1920x1080) is frame 0 of the hero video (1280x720, 6 s,
 *   30 fps), whose last transition lands back on frame 0, so Nuvio's hand-over
 *   between still and video is invisible in both directions.
 *
 * The video keeps per-frame work low: the camera pans by whole pixels (plain
 * row copies) and per-pixel work happens only in transition frames, so a cold
 * render plus encode stays within a few seconds.
 */
const { getSharp } = require('./sharp');
const R = require('./render');

const I = R._internals;
const { clamp, smoothstep } = I;

// ---- Timeline -----------------------------------------------------------------------

const FOCUS_MS = 100;
const FOCUS_PER = 12; // frames per picture (1.2 s)
const FOCUS_TRANS = 5; // of which the last ones hand over to the next picture
const FOCUS_PICTURES = 4;
const GIF_HOLD_MS = 1500;
const GIF_TRANS = [1 / 3, 2 / 3];
const GIF_TRANS_MS = 110;
const VIDEO = { size: [1280, 720], fps: 30, seconds: 6, pictures: 3, trans: 16 };
const HERO_SIZE = [1920, 1080];
const PAN = 0.05; // video camera travel: up to 5% of the width either way
const ZOOM = 0.1; // focus camera zoom range

// ---- Seeded randomness -------------------------------------------------------------

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1] on a W x H grid, `cells` across, `octaves` layers. */
function valueNoise(W, H, rand, cells = 6, octaves = 3) {
  const out = new Float32Array(W * H);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = Math.max(2, Math.round(cells * 2 ** o));
    const cy = Math.max(2, Math.round((cx * H) / W));
    const grid = new Float32Array((cx + 1) * (cy + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < H; y++) {
      const fy = (y / H) * cy;
      const iy = Math.min(cy - 1, Math.floor(fy));
      let ty = fy - iy;
      ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < W; x++) {
        const fx = (x / W) * cx;
        const ix = Math.min(cx - 1, Math.floor(fx));
        let tx = fx - ix;
        tx = tx * tx * (3 - 2 * tx);
        const g = iy * (cx + 1) + ix;
        const top = grid[g] + (grid[g + 1] - grid[g]) * tx;
        const bot = grid[g + cx + 1] + (grid[g + cx + 2] - grid[g + cx + 1]) * tx;
        out[y * W + x] += amp * (top + (bot - top) * ty);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < out.length; i++) {
    out[i] /= total;
    if (out[i] < lo) lo = out[i];
    if (out[i] > hi) hi = out[i];
  }
  const span = hi - lo || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
  return out;
}

// ---- Families -----------------------------------------------------------------------

/**
 * Family definitions. tr: transition; grade: colour treatment of the pictures
 * (applied once, when decoding); decor: static marks in the shading layer;
 * accent: light moving over every frame; edge/soft/edgeK: the glowing (or inky)
 * rim of threshold transitions.
 */
const FAMILIES = {
  beam: { tr: 'sweep', soft: 0.22, edge: [255, 236, 200], edgeK: 0.85, accent: 'beam', grade: { sat: 1.06 } },
  signal: { tr: 'glitch', decor: 'scanlines', accent: 'glitchrows', grade: { sat: 1.1, contrast: 1.06 } },
  reel: { tr: 'reel', accent: 'sprockets', grade: { warm: 0.12, sat: 1.04 } },
  flicker: { tr: 'lightning', decor: 'vignette', accent: 'flicker', grade: { sat: 0.55, contrast: 1.12, bright: 0.92 } },
  holo: { tr: 'threshold', map: 'scan', soft: 0.035, edge: [90, 225, 255], edgeK: 1, decor: 'scanlines', accent: 'scanline', grade: { cool: 0.12, sat: 1.05 } },
  impact: { tr: 'flash', grade: { contrast: 1.16, sat: 1.08 } },
  halftone: { tr: 'threshold', map: 'halftone', soft: 0.12, edge: [255, 255, 255], edgeK: 0.25, grade: { sat: 1.22, bright: 1.03 } },
  bokeh: { tr: 'threshold', map: 'cloud', soft: 0.45, accent: 'orbs', grade: { warm: 0.1, sat: 1.05, bright: 1.02 } },
  blinds: { tr: 'threshold', map: 'blinds', soft: 0.1, decor: 'slats', grade: { sat: 0.72, contrast: 1.12 } },
  rack: { tr: 'rack', grade: { warm: 0.05 } },
  sepia: { tr: 'threshold', map: 'burn', soft: 0.1, edge: [255, 150, 60], edgeK: 0.95, accent: 'dust', grade: { sepia: 0.85 } },
  iris: { tr: 'threshold', map: 'iris', soft: 0.07, edge: [255, 246, 222], edgeK: 0.75, accent: 'sparkle', grade: { sat: 1.15 } },
  eq: { tr: 'threshold', map: 'eq', soft: 0.05, edge: [255, 255, 255], edgeK: 0.45, accent: 'pulse', grade: { sat: 1.12 } },
  mosaic: { tr: 'threshold', map: 'mosaic', soft: 0.08, grade: { sat: 1.12 } },
  warp: { tr: 'ripple', grade: { sat: 1.18 } },
  vhs: { tr: 'tracking', decor: 'scanlines', grade: { sat: 0.88, warm: 0.04 } },
  ghost: { tr: 'ghost', decor: 'vignette', accent: 'flicker-soft', grade: { sat: 0.45, cool: 0.1 } },
  carousel: { tr: 'push', grade: { sat: 1.06 } },
  flap: { tr: 'flap', grade: { contrast: 1.05 } },
  ink: { tr: 'threshold', map: 'ink', soft: 0.09, edge: [6, 6, 10], edgeK: 0.9, grade: { sat: 1.16 } },
  slices: { tr: 'threshold', map: 'slices', soft: 0.06, grade: { sat: 1.08 } },
};

const BY_GENRE = {
  action: 'impact', war: 'impact', comedy: 'halftone', family: 'halftone', kids: 'iris', drama: 'rack',
  documentary: 'rack', thriller: 'blinds', crime: 'blinds', mystery: 'ghost', horror: 'flicker',
  'science-fiction': 'holo', fantasy: 'iris', animation: 'mosaic', romance: 'bokeh', history: 'reel',
  western: 'sepia', music: 'eq', reality: 'mosaic',
};
const BY_KEY = {
  // Spotlight
  'trending-now': 'beam', 'trending-in-india': 'reel', 'new-releases': 'signal', 'coming-soon': 'iris',
  'top-rated': 'slices', 'imdb-top-250': 'flap', 'most-watched-this-week': 'eq', 'best-of-the-best': 'beam',
  decades: 'vhs', 'by-runtime': 'mosaic',
  // Indian cinema
  'pan-india-blockbusters': 'impact', 'indian-web-series': 'signal', 'indian-universes': 'carousel',
  'comedy-franchises': 'halftone', 'indian-studios': 'flap', 'indian-directors': 'rack',
  // Moods and themes
  'mind-bending': 'warp', 'feel-good': 'bokeh', 'edge-of-your-seat': 'blinds', heists: 'flap',
  'true-stories': 'rack', superheroes: 'impact', 'time-travel': 'vhs', 'post-apocalyptic': 'sepia',
  cyberpunk: 'signal', zombies: 'flicker', 'martial-arts': 'ink', slashers: 'flicker', haunted: 'ghost',
  'true-crime': 'blinds', 'stand-up': 'beam',
  // World and anime
  anime: 'ink', 'anime-studios': 'ink',
};
const BY_COLLECTION = {
  spotlight: 'beam', streaming: 'signal', 'indian-cinema': 'reel', genres: 'rack', moods: 'warp',
  franchises: 'carousel', studios: 'flap', world: 'slices',
};

// Signature matches that always win: the motion that belongs to the title.
const SIGNATURE = {
  'james-bond': 'iris', // the gun-barrel iris
  'conjuring-universe': 'ghost',
  'star-wars': 'holo',
  'the-matrix': 'signal',
  'the-lord-of-the-rings': 'sepia',
  'marvel-cinematic-universe': 'impact',
  'back-to-the-future': 'vhs',
  'hayao-miyazaki': 'ink',
  'stanley-kubrick': 'iris',
  'christopher-nolan': 'warp',
  netflix: 'signal',
  imdb: 'flap',
};
// Collections whose tiles would otherwise share one motion: each tile takes the
// next family of the palette (skipping its neighbour's), in data/collections.json order.
const PALETTES = {
  streaming: ['signal', 'beam', 'flap', 'slices', 'holo', 'eq', 'iris', 'carousel', 'mosaic', 'warp', 'vhs'],
  'indian-cinema': ['reel', 'impact', 'sepia', 'ink', 'bokeh', 'slices', 'flap', 'eq', 'halftone', 'vhs', 'mosaic', 'iris', 'beam', 'signal', 'rack', 'carousel', 'warp'],
  franchises: ['carousel', 'flicker', 'warp', 'blinds', 'beam', 'halftone', 'slices', 'rack', 'reel', 'eq', 'mosaic', 'bokeh', 'flap', 'ink', 'signal', 'impact', 'holo', 'sepia', 'iris', 'vhs', 'ghost'],
  studios: ['flap', 'rack', 'beam', 'mosaic', 'reel', 'blinds', 'eq', 'slices', 'carousel', 'halftone', 'iris', 'sepia', 'holo', 'bokeh', 'vhs', 'warp', 'ink', 'signal', 'impact', 'flicker', 'ghost'],
  world: ['slices', 'ink', 'bokeh', 'reel', 'flap', 'mosaic', 'rack', 'sepia', 'beam', 'eq', 'halftone', 'carousel'],
};
let rotation = null;
const ORDER = Object.keys(FAMILIES);
/** Family per folder key: palettes and neighbour guard (computed once from data/collections.json). */
function paletteFamilies() {
  if (rotation) return rotation;
  rotation = new Map();
  let data = { collections: [] };
  try {
    data = require('../../data/collections.json');
  } catch {
    // no data: palettes are off
  }
  for (const c of data.collections || []) {
    const palette = PALETTES[c.id];
    let cursor = 0;
    let prev = null;
    for (const f of c.folders || []) {
      let name = SIGNATURE[f.id];
      if (!name && palette) {
        for (let tries = 0; tries < palette.length; tries++) {
          const pick = palette[cursor++ % palette.length];
          if (pick !== prev) {
            name = pick;
            break;
          }
        }
      }
      if (!name) name = BY_KEY[f.id] || BY_GENRE[f.id] || (f.person ? 'rack' : null) || BY_COLLECTION[c.id] || 'beam';
      // Never the same motion as the tile before it.
      if (name === prev) name = ORDER[(ORDER.indexOf(name) + 7) % ORDER.length];
      rotation.set(f.id, name);
      prev = name;
    }
  }
  return rotation;
}
/**
 * The motion family and seed of a folder.
 * @param {{key: string, kind?: string, collectionId?: string}} folder
 * @returns {{name: string, seed: number}}
 */
function familyFor(folder) {
  const key = String(folder.key || '');
  let name = SIGNATURE[key] || paletteFamilies().get(key) || BY_KEY[key] || BY_GENRE[key];
  if (!name && folder.kind === 'person') name = 'rack';
  if (!name) name = BY_COLLECTION[folder.collectionId] || 'beam';
  return { name, seed: hashSeed(`${folder.collectionId || ''}/${key}`) };
}

// ---- Pictures -------------------------------------------------------------------------

/** Decode, cover-crop to w x h and colour-grade a picture: raw RGB, or null. */
async function decodeGraded(input, w, h, grade = {}, blur = 0) {
  const buf = I.asBuffer(input);
  if (!buf) return null;
  const meta = await I.inspect(buf);
  if (!meta) return null;
  try {
    const base = I.CANVAS_BASE;
    let img = getSharp()(buf, I.loadOptions(meta, Math.max(w / meta.width, h / meta.height)))
      .resize(w, h, { fit: 'cover', position: 'attention' })
      .flatten({ background: { r: base[0], g: base[1], b: base[2] } });
    if (blur >= 0.3) img = img.blur(blur);
    const { data, info } = await img.toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== w || info.height !== h || info.channels !== 3) return null;
    gradeInPlace(data, grade);
    return data;
  } catch {
    return null;
  }
}

/** Colour treatment as one 256-entry table per channel plus a saturation mix. */
function gradeInPlace(rgb, g) {
  const sat = g.sat === undefined ? 1 : g.sat;
  const contrast = g.contrast || 1;
  const bright = g.bright || 1;
  const warm = g.warm || 0;
  const cool = g.cool || 0;
  const sepia = g.sepia || 0;
  if (sat === 1 && contrast === 1 && bright === 1 && !warm && !cool && !sepia) return;
  const lut = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  const tint = [1 + warm * 0.6 - cool * 0.5, 1 + warm * 0.1 - cool * 0.05, 1 - warm * 0.6 + cool * 0.6];
  for (let c = 0; c < 3; c++) {
    for (let v = 0; v < 256; v++) lut[c][v] = clamp(Math.round(((v - 128) * contrast + 128) * bright * tint[c]), 0, 255);
  }
  for (let q = 0; q < rgb.length; q += 3) {
    let r = rgb[q];
    let gg = rgb[q + 1];
    let b = rgb[q + 2];
    const l = 0.299 * r + 0.587 * gg + 0.114 * b;
    if (sepia) {
      const sr = Math.min(255, l * 1.07 + 18);
      const sg = Math.min(255, l * 0.95 + 6);
      const sb = l * 0.74;
      r += (sr - r) * sepia;
      gg += (sg - gg) * sepia;
      b += (sb - b) * sepia;
    }
    if (sat !== 1) {
      r = l + (r - l) * sat;
      gg = l + (gg - l) * sat;
      b = l + (b - l) * sat;
    }
    rgb[q] = lut[0][clamp(r | 0, 0, 255)];
    rgb[q + 1] = lut[1][clamp(gg | 0, 0, 255)];
    rgb[q + 2] = lut[2][clamp(b | 0, 0, 255)];
  }
}

// ---- Cameras --------------------------------------------------------------------------

/** A camera path per picture: start and end window positions (and zooms, for focus loops). */
function cameraPaths(rand, n) {
  const paths = [];
  for (let j = 0; j < n; j++) {
    const a = rand() * Math.PI * 2;
    const r = 0.35 + rand() * 0.15;
    const zoomIn = rand() < 0.5;
    paths.push({
      x: [0.5 - Math.cos(a) * r, 0.5 + Math.cos(a) * r],
      y: [0.5 - Math.sin(a) * r, 0.5 + Math.sin(a) * r],
      z: zoomIn ? [0.15, 0.9] : [0.9, 0.15],
    });
  }
  return paths;
}

const lerp = ([a, b], u) => a + (b - a) * u;

/** Focus view: bilinear window into an oversized still. */
function focusView(scene, j, u, out) {
  const p = scene.paths[j];
  const zMax = scene.SW / scene.W;
  const z = 1 + (zMax - 1) * lerp(p.z, u);
  return I.kenBurnsView(scene.stills[j], scene.SW, scene.SH, scene.W, scene.H, z, lerp(p.x, u), lerp(p.y, u), out);
}

/** Video view: a whole-pixel window into a still decoded with a pan margin (row copies). */
function panView(scene, j, u, out, src = scene.stills[j]) {
  const p = scene.paths[j];
  const { W, H, SW, SH } = scene;
  const ox = Math.round((SW - W) * clamp(lerp(p.x, u), 0, 1));
  const oy = Math.round((SH - H) * clamp(lerp(p.y, u), 0, 1));
  const rowBytes = W * 3;
  for (let y = 0; y < H; y++) src.copy(out, y * rowBytes, ((y + oy) * SW + ox) * 3, ((y + oy) * SW + ox) * 3 + rowBytes);
  return out;
}

// ---- Transition maps --------------------------------------------------------------------

/** Per-pixel reveal order in [0, 1] for threshold transitions (lower shows the next picture first). */
function orderMap(name, W, H, rand) {
  const m = new Float32Array(W * H);
  const set = (fn) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = fn(x / W, y / H, x, y);
  };
  switch (name) {
    case 'sweep': {
      const a = (rand() * 0.5 + 0.1) * Math.PI * (rand() < 0.5 ? 1 : -1);
      const c = Math.cos(a);
      const s = Math.sin(a);
      set((u, v) => u * c + v * s);
      break;
    }
    case 'scan': {
      const down = rand() < 0.6;
      set((u, v) => (down ? v : 1 - v));
      break;
    }
    case 'iris': {
      const cx = 0.3 + rand() * 0.4;
      const cy = 0.3 + rand() * 0.4;
      set((u, v) => Math.hypot((u - cx) * (W / H), v - cy));
      break;
    }
    case 'blinds': {
      const n = 5 + Math.floor(rand() * 5);
      const vertical = rand() < 0.35;
      set((u, v) => {
        const along = vertical ? u : v;
        const across = vertical ? v : u;
        return ((along * n) % 1) * 0.75 + across * 0.25;
      });
      break;
    }
    case 'halftone': {
      const cell = Math.max(6, Math.round(W / (16 + rand() * 10)));
      const dir = rand() < 0.5;
      set((u, v, x, y) => {
        const cx = (Math.floor(x / cell) + 0.5) * cell;
        const cy = (Math.floor(y / cell) + 0.5) * cell;
        const d = Math.hypot(x - cx, y - cy) / (cell * 0.72);
        const sweep = dir ? (cx / W + cy / H) / 2 : (1 - cx / W + cy / H) / 2;
        return d * 0.45 + sweep * 0.55;
      });
      break;
    }
    case 'mosaic': {
      const n = 10 + Math.floor(rand() * 10);
      const bw = W / n;
      const bh = bw;
      const rows = Math.ceil(H / bh);
      const r = new Float32Array(n * rows).map(() => rand());
      set((u, v, x, y) => r[Math.min(rows - 1, Math.floor(y / bh)) * n + Math.min(n - 1, Math.floor(x / bw))]);
      break;
    }
    case 'eq': {
      const n = 12 + Math.floor(rand() * 10);
      const r = new Float32Array(n).map(() => rand());
      set((u, v) => (1 - v) * 0.65 + r[Math.min(n - 1, Math.floor(u * n))] * 0.35);
      break;
    }
    case 'slices': {
      const n = 5 + Math.floor(rand() * 5);
      const order = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
      set((u, v) => {
        const i = Math.min(n - 1, Math.floor(u * n));
        const along = i % 2 ? v : 1 - v;
        return (order[i] / n) * 0.6 + along * 0.4;
      });
      break;
    }
    case 'ink': {
      const noise = valueNoise(W, H, rand, 3 + rand() * 3, 4);
      const cx = rand();
      const cy = rand();
      set((u, v, x, y) => noise[y * W + x] * 0.6 + Math.hypot(u - cx, v - cy) * 0.4);
      break;
    }
    case 'burn': {
      const noise = valueNoise(W, H, rand, 4, 4);
      const cx = rand() < 0.5 ? 0 : 1;
      set((u, v, x, y) => noise[y * W + x] * 0.55 + Math.abs(u - cx) * 0.45);
      break;
    }
    case 'cloud':
    default: {
      const noise = valueNoise(W, H, rand, 2.5, 3);
      for (let i = 0; i < m.length; i++) m[i] = noise[i];
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < m.length; i++) {
    if (m[i] < lo) lo = m[i];
    if (m[i] > hi) hi = m[i];
  }
  const span = hi - lo || 1;
  for (let i = 0; i < m.length; i++) m[i] = (m[i] - lo) / span;
  return m;
}

// ---- Transitions ------------------------------------------------------------------------
// Each mixes the outgoing view `a` and the incoming view `b` (W x H RGB) at progress
// t in (0, 1) into `out`. Views come from scene.view(j, u, buffer).

const ease = (t) => t * t * (3 - 2 * t);
const SINE_STEPS = 1024;
const SINE_MASK = SINE_STEPS - 1;
const SINE = Float32Array.from({ length: SINE_STEPS }, (_, i) => Math.sin((2 * Math.PI * i) / SINE_STEPS));

function thresholdMix(scene, a, b, t, out) {
  const { fam, order } = scene;
  const soft = fam.soft || 0.1;
  const edge = fam.edge;
  const k = fam.edgeK || 0;
  const level = t * (1 + soft);
  const inv = 1 / soft;
  const dark = edge && edge[0] + edge[1] + edge[2] < 60;
  for (let p = 0, q = 0; p < order.length; p++, q += 3) {
    const al = clamp((level - order[p]) * inv, 0, 1);
    if (al <= 0) {
      out[q] = a[q];
      out[q + 1] = a[q + 1];
      out[q + 2] = a[q + 2];
      continue;
    }
    if (al >= 1) {
      out[q] = b[q];
      out[q + 1] = b[q + 1];
      out[q + 2] = b[q + 2];
      continue;
    }
    let r = a[q] + (b[q] - a[q]) * al;
    let g = a[q + 1] + (b[q + 1] - a[q + 1]) * al;
    let bl = a[q + 2] + (b[q + 2] - a[q + 2]) * al;
    if (edge && k) {
      const e = 4 * al * (1 - al) * k;
      if (dark) {
        r += (edge[0] - r) * e;
        g += (edge[1] - g) * e;
        bl += (edge[2] - bl) * e;
      } else {
        r += edge[0] * e * 0.8;
        g += edge[1] * e * 0.8;
        bl += edge[2] * e * 0.8;
      }
    }
    out[q] = r > 255 ? 255 : r;
    out[q + 1] = g > 255 ? 255 : g;
    out[q + 2] = bl > 255 ? 255 : bl;
  }
  return out;
}

function mixPlain(a, b, w, out) {
  const wb = Math.round(w * 256);
  const wa = 256 - wb;
  for (let i = 0; i < a.length; i++) out[i] = (a[i] * wa + b[i] * wb + 128) >> 8;
  return out;
}

function toward(buf, rgb, w, out = buf) {
  if (w <= 0) return out === buf ? buf : (buf.copy(out), out);
  const wb = Math.round(clamp(w, 0, 1) * 256);
  const wa = 256 - wb;
  for (let q = 0; q < buf.length; q += 3) {
    out[q] = (buf[q] * wa + rgb[0] * wb + 128) >> 8;
    out[q + 1] = (buf[q + 1] * wa + rgb[1] * wb + 128) >> 8;
    out[q + 2] = (buf[q + 2] * wa + rgb[2] * wb + 128) >> 8;
  }
  return out;
}

/** Copy `src` into `out`, shifted by (dx, dy) whole pixels; uncovered pixels repeat the edge. */
function shifted(src, W, H, dx, dy, out) {
  for (let y = 0; y < H; y++) {
    const sy = clamp(y - dy, 0, H - 1);
    const row = sy * W * 3;
    const x0 = clamp(dx, 0, W);
    const from = clamp(-dx, 0, W);
    const len = W - Math.abs(dx);
    if (len > 0) src.copy(out, y * W * 3 + x0 * 3, row + from * 3, row + (from + len) * 3);
    for (let x = 0; x < x0; x++) src.copy(out, (y * W + x) * 3, row, row + 3);
    for (let x = x0 + Math.max(0, len); x < W; x++) src.copy(out, (y * W + x) * 3, row + (W - 1) * 3, row + W * 3);
  }
  return out;
}

const SPECIAL = {
  glitch(scene, a, b, t, out) {
    const { W, H, bands } = scene;
    const amp = Math.sin(Math.PI * t);
    const split = Math.round(W * 0.012 * amp);
    for (const band of bands) {
      const src = band.r < t ? b : a;
      const dx = Math.round(band.dx * W * 0.12 * amp);
      for (let y = band.y0; y < band.y1; y++) {
        const row = y * W * 3;
        for (let x = 0; x < W; x++) {
          const q = row + x * 3;
          out[q] = src[row + clamp(x - dx + split, 0, W - 1) * 3];
          out[q + 1] = src[row + clamp(x - dx, 0, W - 1) * 3 + 1];
          out[q + 2] = src[row + clamp(x - dx - split, 0, W - 1) * 3 + 2];
        }
      }
    }
    return out;
  },
  reel(scene, a, b, t, out) {
    const { W, H } = scene;
    const bar = Math.round(H * 0.07);
    const shift = Math.round(ease(t) * (H + bar));
    const rowBytes = W * 3;
    for (let y = 0; y < H; y++) {
      const s = y + shift;
      if (s < H) a.copy(out, y * rowBytes, s * rowBytes, (s + 1) * rowBytes);
      else if (s < H + bar) out.fill(4, y * rowBytes, (y + 1) * rowBytes);
      else b.copy(out, y * rowBytes, (s - H - bar) * rowBytes, (s - H - bar + 1) * rowBytes);
    }
    // The projector's lamp flickers as the frame passes the gate.
    return toward(out, [255, 236, 200], 0.18 * Math.sin(Math.PI * t));
  },
  lightning(scene, a, b, t, out) {
    const bump = (c, w) => Math.max(0, 1 - Math.abs(t - c) / w);
    const flash = Math.max(bump(0.22, 0.09), bump(0.5, 0.07) * 0.85, bump(0.62, 0.05) * 0.6);
    const base = t < 0.5 ? a : b;
    const dim = t > 0.3 && t < 0.45 ? 0.35 : 1;
    const wb = Math.round(flash * 256);
    for (let q = 0; q < base.length; q++) out[q] = ((base[q] * dim * (256 - wb)) + 235 * wb) >> 8;
    return out;
  },
  flash(scene, a, b, t, out) {
    const { W, H, rand2 } = scene;
    const white = t < 0.3 ? smoothstep(0, 0.3, t) : 1 - smoothstep(0.3, 0.8, t);
    const src = t < 0.3 ? a : b;
    const shake = t < 0.3 ? 0 : (1 - t) * W * 0.03;
    const dx = Math.round((rand2() - 0.5) * 2 * shake);
    const dy = Math.round((rand2() - 0.5) * 2 * shake * 0.6);
    shifted(src, W, H, dx, dy, out);
    return toward(out, [255, 250, 240], white * 0.6);
  },
  rack(scene, a, b, t, out, ctx) {
    // Out of focus, then into focus on the next picture.
    const aBlur = ctx.viewBlur(ctx.j, ctx.ua, scene.tmp1);
    const bBlur = ctx.viewBlur(ctx.next, 0, scene.tmp2);
    if (t < 0.5) {
      const w = ease(t * 2);
      mixPlain(a, aBlur, w, out);
      return t > 0.35 ? mixPlain(out, bBlur, (t - 0.35) / 0.3, out) : out;
    }
    const w = ease((t - 0.5) * 2);
    mixPlain(bBlur, b, w, out);
    return t < 0.65 ? mixPlain(aBlur, out, (t - 0.35) / 0.3, out) : out;
  },
  ripple(scene, a, b, t, out) {
    const { W, H } = scene;
    if (!scene.rippleGeo) {
      // Per pixel, once: distance from the centre (in sine-table steps per wave) and direction.
      const { cx, cy } = scene;
      const n = W * H;
      const phase = new Float32Array(n);
      const ux = new Float32Array(n);
      const uy = new Float32Array(n);
      const wave = W * 0.12;
      for (let y = 0, p = 0; y < H; y++) {
        for (let x = 0; x < W; x++, p++) {
          const dx = x - cx;
          const dy = y - cy;
          const r = Math.sqrt(dx * dx + dy * dy) + 1e-3;
          phase[p] = (r / wave) * SINE_STEPS;
          ux[p] = dx / r;
          uy[p] = dy / r;
        }
      }
      scene.rippleGeo = { phase, ux, uy };
    }
    const { phase, ux, uy } = scene.rippleGeo;
    const amp = Math.sin(Math.PI * t) * W * 0.018;
    const shift = Math.round(t * 3 * SINE_STEPS);
    const wb = Math.round(ease(clamp((t - 0.25) / 0.5, 0, 1)) * 256);
    const wa = 256 - wb;
    for (let y = 0, p = 0; y < H; y++) {
      for (let x = 0; x < W; x++, p++) {
        const d = amp * SINE[((phase[p] | 0) - shift) & SINE_MASK];
        let sx = (x + ux[p] * d + 0.5) | 0;
        let sy = (y + uy[p] * d + 0.5) | 0;
        if (sx < 0) sx = 0;
        else if (sx >= W) sx = W - 1;
        if (sy < 0) sy = 0;
        else if (sy >= H) sy = H - 1;
        const s = (sy * W + sx) * 3;
        const q = p * 3;
        out[q] = (a[s] * wa + b[s] * wb) >> 8;
        out[q + 1] = (a[s + 1] * wa + b[s + 1] * wb) >> 8;
        out[q + 2] = (a[s + 2] * wa + b[s + 2] * wb) >> 8;
      }
    }
    return out;
  },
  tracking(scene, a, b, t, out) {
    const { W, H, rand2 } = scene;
    const band = Math.round(H * 0.16);
    const yb = Math.round(t * (H + band)) - band;
    const rowBytes = W * 3;
    for (let y = 0; y < H; y++) {
      if (y < yb) b.copy(out, y * rowBytes, y * rowBytes, (y + 1) * rowBytes);
      else if (y >= yb + band) a.copy(out, y * rowBytes, y * rowBytes, (y + 1) * rowBytes);
      else {
        // Tracking noise: the picture tears sideways and dissolves into static.
        const jitter = Math.round((rand2() - 0.5) * W * 0.08);
        const src = rand2() < 0.5 ? a : b;
        for (let x = 0; x < W; x++) {
          const q = y * rowBytes + x * 3;
          const s = y * rowBytes + clamp(x + jitter, 0, W - 1) * 3;
          const n = rand2() * 255;
          out[q] = (src[s] + n) >> 1;
          out[q + 1] = (src[s + 1] + n) >> 1;
          out[q + 2] = (src[s + 2] + n) >> 1;
        }
      }
    }
    return out;
  },
  ghost(scene, a, b, t, out) {
    const { W, H } = scene;
    const off = Math.round((1 - t) * W * 0.07);
    const wb = Math.round(ease(t) * 256);
    const wa = 256 - wb;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const q = (row + x) * 3;
        const sx = x + off;
        const s = (row + (sx < W ? sx : W - 1)) * 3;
        // Screen blend of both exposures: the next picture rises through the last.
        out[q] = 255 - (((255 - ((a[q] * wa) >> 8)) * (255 - ((b[s] * wb) >> 8))) >> 8);
        out[q + 1] = 255 - (((255 - ((a[q + 1] * wa) >> 8)) * (255 - ((b[s + 1] * wb) >> 8))) >> 8);
        out[q + 2] = 255 - (((255 - ((a[q + 2] * wa) >> 8)) * (255 - ((b[s + 2] * wb) >> 8))) >> 8);
      }
    }
    return out;
  },
  push(scene, a, b, t, out) {
    const { W, H, dir } = scene;
    const shift = Math.round(ease(t) * W);
    const rowBytes = W * 3;
    for (let y = 0; y < H; y++) {
      const row = y * rowBytes;
      if (dir > 0) {
        // a slides out to the left, b comes in from the right.
        if (W - shift > 0) a.copy(out, row, row + shift * 3, row + rowBytes);
        if (shift > 0) b.copy(out, row + (W - shift) * 3, row, row + shift * 3);
      } else {
        if (W - shift > 0) a.copy(out, row + shift * 3, row, row + (W - shift) * 3);
        if (shift > 0) b.copy(out, row, row + (W - shift) * 3, row + rowBytes);
      }
    }
    // Depth: the picture leaving darkens towards its far edge, like a turning carousel.
    const seam = dir > 0 ? W - shift : shift;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const leaving = dir > 0 ? x < seam : x >= seam;
        const d = leaving ? Math.abs(x - seam) / W : 0;
        const k = leaving ? 1 - 0.55 * t * (1 - d) : 0.55 + 0.45 * ease(t);
        if (k >= 0.999) continue;
        const q = (y * W + x) * 3;
        out[q] *= k;
        out[q + 1] *= k;
        out[q + 2] *= k;
      }
    }
    return out;
  },
  flap(scene, a, b, t, out) {
    const { W, H, flaps } = scene;
    const rowBytes = W * 3;
    const n = flaps;
    const bh = H / n;
    const stagger = 0.5 / n;
    for (let k = 0; k < n; k++) {
      const p = clamp((t - k * stagger) / (1 - (n - 1) * stagger), 0, 1);
      const y0 = Math.round(k * bh);
      const y1 = Math.round((k + 1) * bh);
      const ym = Math.round((y0 + y1) / 2);
      for (let y = y0; y < y1; y++) {
        let src = a;
        let sy = y;
        let shade = 1;
        if (p >= 1) src = b;
        else if (p > 0) {
          if (p < 0.5) {
            const s = Math.cos(p * Math.PI);
            if (y < ym) {
              if (y >= ym - s * (ym - y0)) {
                sy = Math.round(ym - (ym - y) / Math.max(s, 1e-3));
                shade = 0.55 + 0.45 * s;
              } else src = b;
            }
          } else {
            const s = -Math.cos(p * Math.PI);
            if (y < ym) src = b;
            else if (y < ym + s * (y1 - ym)) {
              src = b;
              sy = Math.round(ym + (y - ym) / Math.max(s, 1e-3));
              shade = 0.55 + 0.45 * s;
            }
          }
        }
        sy = clamp(sy, y0, y1 - 1);
        src.copy(out, y * rowBytes, sy * rowBytes, (sy + 1) * rowBytes);
        if (shade < 1) for (let q = y * rowBytes, e = q + rowBytes; q < e; q++) out[q] *= shade;
      }
      // The hinge line between the two halves of a flap.
      if (ym < H) out.fill(0, ym * rowBytes, ym * rowBytes + rowBytes);
    }
    return out;
  },
};

// ---- Accents -------------------------------------------------------------------------
// Light that moves over every frame, as a function of time in seconds, so a 10 fps
// focus loop and a 30 fps video agree. Kept sparse: most touch a few pixels.

function addGlow(out, W, H, cx, cy, r, rgb, k) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  const inv = 1 / r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy) * inv;
      if (d >= 1) continue;
      const w = (1 - d * d) * (1 - d * d) * k;
      const q = (y * W + x) * 3;
      out[q] = Math.min(255, out[q] + rgb[0] * w);
      out[q + 1] = Math.min(255, out[q + 1] + rgb[1] * w);
      out[q + 2] = Math.min(255, out[q + 2] + rgb[2] * w);
    }
  }
}

/** Scale every channel by `gain` (clamped), through a 256-entry table. */
function gainInPlace(out, gain) {
  if (Math.abs(gain - 1) < 0.002) return;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.min(255, Math.round(v * gain));
  for (let q = 0; q < out.length; q++) out[q] = lut[out[q]];
}

const ACCENTS = {
  beam(scene, out, time) {
    // A soft diagonal shaft of light crossing the frame every 2.4 s.
    const { W, H, beamAngle } = scene;
    const period = 2.4;
    const pos = ((time / period + scene.phase) % 1) * 1.6 - 0.3;
    const width = 0.12;
    const slope = Math.tan(beamAngle);
    for (let y = 0; y < H; y++) {
      const centre = (pos + (y / H - 0.5) * slope * (H / W)) * W;
      const x0 = Math.max(0, Math.floor(centre - width * W));
      const x1 = Math.min(W, Math.ceil(centre + width * W));
      for (let x = x0; x < x1; x++) {
        const d = (x - centre) / (width * W);
        const w = Math.max(0, 1 - d * d) * 0.32;
        const q = (y * W + x) * 3;
        out[q] = Math.min(255, out[q] + (255 - out[q]) * w);
        out[q + 1] = Math.min(255, out[q + 1] + (246 - out[q + 1]) * w);
        out[q + 2] = Math.min(255, out[q + 2] + (226 - out[q + 2]) * w);
      }
    }
  },
  glitchrows(scene, out, time) {
    // Now and then a few rows of the picture slip sideways, as on a weak signal.
    const { W, H } = scene;
    const tick = Math.floor(time * 10);
    const r = rng(scene.seed ^ (tick * 2654435761));
    if (r() > 0.18) return;
    const rows = 1 + Math.floor(r() * 3);
    for (let i = 0; i < rows; i++) {
      const y0 = Math.floor(r() * H);
      const h = Math.max(1, Math.round(H * (0.01 + r() * 0.04)));
      const dx = Math.round((r() - 0.5) * W * 0.06);
      for (let y = y0; y < Math.min(H, y0 + h); y++) {
        const row = Buffer.from(out.subarray(y * W * 3, (y + 1) * W * 3));
        shifted(row, W, 1, dx, 0, out.subarray(y * W * 3, (y + 1) * W * 3));
      }
    }
  },
  sprockets(scene, out, time) {
    // Film sprocket holes running down both edges, lit from behind.
    const { W, H } = scene;
    const strip = Math.max(6, Math.round(W * 0.035));
    const pitch = strip * 1.5;
    const holeW = Math.round(strip * 0.5);
    const holeH = Math.round(strip * 0.7);
    const shift = (time * pitch * 4) % pitch;
    for (const left of [0, W - strip]) {
      for (let y = 0; y < H; y++) {
        const row = (y * W + left) * 3;
        out.fill(6, row, row + strip * 3);
        const local = (y + shift) % pitch;
        if (local < holeH) {
          const hx = left + Math.round((strip - holeW) / 2);
          for (let x = hx; x < hx + holeW; x++) {
            const q = (y * W + x) * 3;
            out[q] = 214;
            out[q + 1] = 205;
            out[q + 2] = 186;
          }
        }
      }
    }
  },
  flicker(scene, out, time) {
    const tick = Math.floor(time * 10);
    const r = rng(scene.seed ^ (tick * 40503));
    const v = r();
    gainInPlace(out, v < 0.12 ? 0.55 + r() * 0.2 : 0.93 + r() * 0.07);
  },
  'flicker-soft'(scene, out, time) {
    gainInPlace(out, 0.92 + 0.08 * Math.sin(time * 7.3 + scene.phase * 6) * Math.sin(time * 3.1));
  },
  scanline(scene, out, time) {
    // A bright scan line rolling down the hologram.
    const { W, H } = scene;
    const y = Math.floor(((time / 1.8 + scene.phase) % 1) * H);
    const h = Math.max(2, Math.round(H * 0.012));
    for (let yy = y; yy < Math.min(H, y + h); yy++) {
      for (let x = 0; x < W; x++) {
        const q = (yy * W + x) * 3;
        out[q] = Math.min(255, out[q] + 40);
        out[q + 1] = Math.min(255, out[q + 1] + 90);
        out[q + 2] = Math.min(255, out[q + 2] + 110);
      }
    }
  },
  orbs(scene, out, time) {
    // Out-of-focus lights drifting upwards.
    const { W, H, orbs } = scene;
    for (const o of orbs) {
      const y = (((o.y - time * o.speed) % 1) + 1) % 1;
      const x = o.x + Math.sin(time * o.wobble + o.p) * 0.02;
      addGlow(out, W, H, x * W, y * H, o.r * H, o.rgb, 0.42);
    }
  },
  dust(scene, out, time) {
    // Old film: dust specks and a scratch that jump every frame.
    const { W, H } = scene;
    const tick = Math.floor(time * 12);
    const r = rng(scene.seed ^ (tick * 97));
    const specks = 6;
    for (let i = 0; i < specks; i++) {
      const x = Math.floor(r() * W);
      const y = Math.floor(r() * H);
      const s = Math.max(1, Math.round(r() * W * 0.004));
      const v = r() < 0.5 ? 20 : 225;
      for (let yy = y; yy < Math.min(H, y + s); yy++) for (let xx = x; xx < Math.min(W, x + s); xx++) out.fill(v, (yy * W + xx) * 3, (yy * W + xx) * 3 + 3);
    }
    if (r() < 0.6) {
      const x = Math.floor(r() * W);
      for (let y = 0; y < H; y++) {
        const q = (y * W + x) * 3;
        out[q] = Math.min(255, out[q] + 45);
        out[q + 1] = Math.min(255, out[q + 1] + 40);
        out[q + 2] = Math.min(255, out[q + 2] + 30);
      }
    }
  },
  sparkle(scene, out, time) {
    // Four-point stars twinkling in and out.
    const { W, H, stars } = scene;
    for (const s of stars) {
      const life = Math.sin(((time / s.period + s.p) % 1) * Math.PI);
      if (life <= 0.05) continue;
      const cx = s.x * W;
      const cy = s.y * H;
      const len = Math.max(3, s.r * H * life);
      for (let d = -len; d <= len; d++) {
        const w = (1 - Math.abs(d) / len) ** 2 * life;
        for (const [x, y] of [
          [Math.round(cx + d), Math.round(cy)],
          [Math.round(cx), Math.round(cy + d)],
        ]) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const q = (y * W + x) * 3;
          out[q] = Math.min(255, out[q] + 255 * w);
          out[q + 1] = Math.min(255, out[q + 1] + 248 * w);
          out[q + 2] = Math.min(255, out[q + 2] + 220 * w);
        }
      }
      addGlow(out, W, H, cx, cy, len * 0.5, [255, 245, 215], 0.5 * life);
    }
  },
  pulse(scene, out, time) {
    // The picture breathes on the beat (120 bpm).
    const beat = (time * 2) % 1;
    gainInPlace(out, 1 + 0.07 * Math.exp(-beat * 6));
  },
};

// ---- Static decor ---------------------------------------------------------------------

function decorate(name, field) {
  const { w: W, h: H, a } = field;
  const stack = (p, v) => {
    a[p] = 1 - (1 - a[p]) * (1 - v);
  };
  if (name === 'scanlines') {
    const pitch = H > 400 ? 3 : 2;
    for (let y = 0; y < H; y += pitch) for (let x = 0; x < W; x++) stack(y * W + x, 0.16);
  } else if (name === 'vignette') {
    I.stackRadial(field, W / 2, H / 2, Math.hypot(W, H) / 2, (d) => 0.55 * smoothstep(0.45, 1.05, d));
  } else if (name === 'slats') {
    // Light through venetian blinds, falling across the picture.
    const pitch = H / 7;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = ((y + x * 0.35) % pitch) / pitch;
        if (v > 0.62) stack(y * W + x, 0.3 * smoothstep(0.62, 0.7, v));
      }
    }
  }
}

// ---- Scenes ---------------------------------------------------------------------------

/**
 * Everything a family needs to draw frames at W x H from decoded pictures.
 * @param {{name: string, seed: number}} family
 * @param {Buffer[]} stills decoded pictures, SW x SH
 * @param {'focus'|'video'} mode bilinear zooming camera, or whole-pixel pans
 */
function makeScene(family, stills, W, H, SW, SH, mode, blurred = null) {
  const fam = FAMILIES[family.name] || FAMILIES.beam;
  const rand = rng(family.seed);
  const scene = {
    fam,
    name: family.name,
    seed: family.seed,
    W,
    H,
    SW,
    SH,
    stills,
    blurred,
    mode,
    paths: cameraPaths(rand, Math.max(1, stills.length)),
    phase: rand(),
    beamAngle: (rand() - 0.5) * 1.2,
    dir: rand() < 0.5 ? 1 : -1,
    flaps: 4 + Math.floor(rand() * 4),
    cx: W * (0.3 + rand() * 0.4),
    cy: H * (0.3 + rand() * 0.4),
    tmp1: Buffer.allocUnsafe(W * H * 3), // blurred views (rack focus)
    tmp2: Buffer.allocUnsafe(W * H * 3),
    viewA: Buffer.allocUnsafe(W * H * 3), // the outgoing and incoming views of a hand-over
    viewB: Buffer.allocUnsafe(W * H * 3),
  };
  scene.rand2 = rng(family.seed ^ 0x5bd1e995);
  if (fam.tr === 'threshold') scene.order = orderMap(fam.map, W, H, rand);
  if (fam.tr === 'sweep') {
    scene.order = orderMap('sweep', W, H, rand);
  }
  if (fam.tr === 'glitch') {
    scene.bands = [];
    for (let y = 0; y < H; ) {
      const h = Math.max(2, Math.round(H * (0.02 + rand() * 0.1)));
      scene.bands.push({ y0: y, y1: Math.min(H, y + h), r: rand(), dx: rand() - 0.5 });
      y += h;
    }
  }
  if (fam.accent === 'orbs') {
    scene.orbs = Array.from({ length: 7 }, () => ({
      x: rand(),
      y: rand(),
      r: 0.05 + rand() * 0.07,
      speed: 0.04 + rand() * 0.06,
      wobble: 0.6 + rand() * 1.2,
      p: rand() * 6.28,
      rgb: rand() < 0.5 ? [255, 196, 150] : [255, 160, 190],
    }));
  }
  if (fam.accent === 'sparkle') {
    scene.stars = Array.from({ length: 9 }, () => ({ x: rand(), y: rand() * 0.8, r: 0.025 + rand() * 0.035, period: 0.9 + rand() * 1.4, p: rand() }));
  }
  scene.view = mode === 'focus' ? (j, u, out) => focusView(scene, j, u, out) : (j, u, out) => panView(scene, j, u, out);
  scene.viewBlur = (j, u, out) =>
    mode === 'focus'
      ? I.kenBurnsView(blurred[j], SW, SH, W, H, 1 + (SW / W - 1) * lerp(scene.paths[j].z, u), lerp(scene.paths[j].x, u), lerp(scene.paths[j].y, u), out)
      : panView(scene, j, u, out, blurred[j]);
  return scene;
}

/** Hand over from picture j (at camera u) to picture `next` (at its start) at progress t. */
function transition(scene, j, ua, next, t, a, b, out) {
  const fam = scene.fam;
  const kind = fam.tr === 'sweep' ? 'threshold' : fam.tr;
  if (kind === 'threshold') return thresholdMix(scene, a, b, t, out);
  const fn = SPECIAL[kind];
  if (!fn) return mixPlain(a, b, ease(t), out);
  return fn(scene, a, b, t, out, { j, ua, next, viewBlur: scene.viewBlur });
}

/**
 * A frame of a timeline of P pictures x `per` frames whose last `trans` frames
 * hand over to the next picture. Frame 0 is picture 0 at its camera start.
 */
function timelineFrame(scene, f, per, trans, fps, out) {
  const P = scene.stills.length;
  const j = Math.floor(f / per) % P;
  const k = f % per;
  const u = k / per;
  const time = f / fps;
  const start = per - trans;
  if (P > 1 && k >= start) {
    const t = (k - start + 1) / (trans + 1);
    const next = (j + 1) % P;
    const a = scene.view(j, u, scene.viewA);
    const b = scene.view(next, 0, scene.viewB);
    transition(scene, j, u, next, t, a, b, out);
  } else scene.view(j, u, out);
  const accent = ACCENTS[scene.fam.accent];
  if (accent) accent(scene, out, time);
  return out;
}

/** Single picture: the camera breathes in and out and comes back to frame 0. */
function breathingFrame(scene, f, count, fps, out) {
  const u = (1 - Math.cos((2 * Math.PI * f) / count)) / 2;
  scene.view(0, u, out);
  const accent = ACCENTS[scene.fam.accent];
  if (accent) accent(scene, out, f / fps);
  return out;
}

async function decodeAll(inputs, SW, SH, grade, max, blur = 0) {
  const list = (Array.isArray(inputs) ? inputs : inputs ? [inputs] : []).filter(Boolean).slice(0, max + 2);
  const decoded = await Promise.all(list.map((b) => decodeGraded(b, SW, SH, grade, blur)));
  return decoded.filter(Boolean).slice(0, max);
}

async function blurAll(stills, SW, SH, sigma) {
  return Promise.all(
    stills.map((s) =>
      getSharp()(s, { raw: { width: SW, height: SH, channels: 3 } })
        .blur(sigma)
        .raw()
        .toBuffer()
    )
  );
}

// ---- Covers and focus loops -------------------------------------------------------------

/** Cover/focus scene setup shared by both: overlay, decoded pictures and the scene. */
async function tileScene({ backdrops, logo, wordmark, shape, brand: brandFolder, family }, W, H, max) {
  const prep = await I.prepareLogo(logo);
  const brand = Boolean(prep) || Boolean(brandFolder);
  const fam = FAMILIES[family.name] || FAMILIES.beam;
  const key = I.COVER[shape] ? shape : 'landscape';
  const SW = Math.ceil(W * (1 + ZOOM));
  const SH = Math.ceil(H * (1 + ZOOM));
  const blur = brand ? (I.BRAND_BLUR_AT_640 * W) / 640 : 0;
  const stills = await decodeAll(backdrops, SW, SH, fam.grade, max, blur * (1 + ZOOM));
  const blurred = fam.tr === 'rack' && stills.length > 1 ? await blurAll(stills, SW, SH, Math.max(2, W / 60)) : null;
  const pre = await I.coverOverlay(key, W, H, prep, wordmark, brand, fam.decor ? (field) => decorate(fam.decor, field) : null);
  const scene = stills.length ? makeScene(family, stills, W, H, SW, SH, 'focus', blurred) : null;
  return { scene, pre, brand };
}

/**
 * Folder cover: frame 0 of the folder's focus loop at the cover size (JPEG).
 * @param {{shape?: string, backdrop?: Buffer|null, logo?: Buffer|null, wordmark?: string,
 *   brand?: boolean, family: {name: string, seed: number}}} input
 */
async function renderMotionCover(input) {
  const key = I.COVER[input.shape] ? input.shape : 'landscape';
  const [W, H] = I.COVER[key].size;
  return I.guard(
    async () => {
      const { scene, pre, brand } = await tileScene({ ...input, shape: key, backdrops: [input.backdrop] }, W, H, 1);
      const out = Buffer.allocUnsafe(W * H * 3);
      const rgb = scene ? timelineFrame(scene, 0, FOCUS_PER, FOCUS_TRANS, 1000 / FOCUS_MS, out) : I.coverCanvas(W, H, brand);
      return I.encodeJpeg(I.applyOverlay(rgb, pre), W, H, 84);
    },
    () => I.encodeJpeg(I.coverCanvas(W, H, false), W, H, 84)
  );
}

/**
 * Animated focus loop in the folder's signature motion (WebP or GIF).
 * @param {{backdrops?: Buffer[], logo?: Buffer|null, wordmark?: string, format?: 'webp'|'gif',
 *   shape?: string, brand?: boolean, family: {name: string, seed: number}}} input
 */
async function renderMotionFocus(input) {
  const key = R.FOCUS_SIZES[input.shape] ? input.shape : 'landscape';
  const [W, H] = R.FOCUS_SIZES[key];
  const fmt = input.format === 'gif' ? 'gif' : 'webp';
  return I.guard(
    async () => {
      const { scene, pre, brand } = await tileScene({ ...input, shape: key }, W, H, FOCUS_PICTURES);
      if (!scene) return I.encodeFrames([I.applyOverlay(I.coverCanvas(W, H, brand), pre)], null, W, H, fmt);
      const P = scene.stills.length;
      const fps = 1000 / FOCUS_MS;
      const frames = [];
      const delays = [];
      if (fmt === 'webp') {
        const count = P === 1 ? 24 : P * FOCUS_PER;
        for (let f = 0; f < count; f++) {
          const out = Buffer.allocUnsafe(W * H * 3);
          if (P === 1) breathingFrame(scene, f, count, fps, out);
          else timelineFrame(scene, f, FOCUS_PER, FOCUS_TRANS, fps, out);
          frames.push(I.applyOverlay(out, pre));
          delays.push(FOCUS_MS);
        }
        return I.encodeFrames(frames, delays, W, H, fmt);
      }
      // GIF: hold each picture, then the signature transition in two frames.
      for (let j = 0; j < P; j++) {
        const out = Buffer.allocUnsafe(W * H * 3);
        scene.view(j, 0, out);
        frames.push(I.applyOverlay(out, pre));
        delays.push(GIF_HOLD_MS);
        if (P < 2) break;
        const next = (j + 1) % P;
        for (const t of GIF_TRANS) {
          const a = scene.view(j, 0, Buffer.allocUnsafe(W * H * 3));
          const b = scene.view(next, 0, Buffer.allocUnsafe(W * H * 3));
          const mix = transition(scene, j, 0, next, t, a, b, Buffer.allocUnsafe(W * H * 3));
          frames.push(I.applyOverlay(mix, pre));
          delays.push(GIF_TRANS_MS);
        }
      }
      return I.encodeFrames(frames, delays, W, H, fmt);
    },
    () => I.encodeFrames([I.coverCanvas(W, H, false)], null, W, H, fmt)
  );
}

// ---- Hero still and video ----------------------------------------------------------------

function heroField(W, H, fam) {
  const field = I.heroShadeField(W, H);
  if (fam.decor) decorate(fam.decor, field);
  return field;
}

async function heroScene({ backdrops, family }, W, H) {
  const fam = FAMILIES[family.name] || FAMILIES.beam;
  const SW = Math.round(W * (1 + 2 * PAN));
  const SH = Math.round(H * (1 + 2 * PAN));
  const stills = await decodeAll(backdrops, SW, SH, fam.grade, VIDEO.pictures);
  if (!stills.length) return null;
  const blurred = fam.tr === 'rack' && stills.length > 1 ? await blurAll(stills, SW, SH, Math.max(3, W / 90)) : null;
  return makeScene(family, stills, W, H, SW, SH, 'video', blurred);
}

const videoPer = (P) => Math.floor((VIDEO.fps * VIDEO.seconds) / P);

/**
 * Hero still (1920x1080 JPEG): frame 0 of the hero video, under the hero shading.
 * @param {{backdrops?: Buffer[], family: {name: string, seed: number}}} input
 */
async function renderMotionHero(input) {
  const [W, H] = HERO_SIZE;
  const fam = FAMILIES[input.family.name] || FAMILIES.beam;
  const shade = (rgb) => I.applyOverlay(rgb, I.precompose(heroField(W, H, fam), null));
  return I.guard(
    async () => {
      const scene = await heroScene(input, W, H);
      if (!scene) return I.encodeJpeg(shade(I.darkCanvas(W, H)), W, H, 80);
      const out = Buffer.allocUnsafe(W * H * 3);
      const P = scene.stills.length;
      const rgb = P === 1 ? breathingFrame(scene, 0, 1, VIDEO.fps, out) : timelineFrame(scene, 0, videoPer(P), VIDEO.trans, VIDEO.fps, out);
      return I.encodeJpeg(shade(rgb), W, H, 82);
    },
    () => I.encodeJpeg(shade(I.darkCanvas(W, H)), W, H, 80)
  );
}

/**
 * Hero video frames in the folder's signature motion, for video.js. It starts on
 * the hero still and its last hand-over lands back on it.
 * @param {{backdrops?: Buffer[], family: {name: string, seed: number}}} input
 * @returns {Promise<null|{width: number, height: number, fps: number, count: number,
 *   frame: (n: number) => Buffer, shade: Buffer}>}
 */
async function motionVideoFrames(input) {
  const [W, H] = VIDEO.size;
  const fam = FAMILIES[input.family.name] || FAMILIES.beam;
  const scene = await heroScene(input, W, H);
  if (!scene) return null;
  const P = scene.stills.length;
  const count = VIDEO.fps * VIDEO.seconds;
  const per = videoPer(P);
  const frame = (n) => {
    const out = Buffer.allocUnsafe(W * H * 3);
    if (P === 1) return breathingFrame(scene, n, count, VIDEO.fps, out);
    // The last frames of the last picture hand back to frame 0.
    return timelineFrame(scene, n, per, VIDEO.trans, VIDEO.fps, out);
  };
  const field = heroField(W, H, fam);
  const rgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) rgba[p * 4 + 3] = Math.round(clamp(field.a[p], 0, 1) * 255);
  const shade = await getSharp()(rgba, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  return { width: W, height: H, fps: VIDEO.fps, count: P === 1 ? count : P * per, frame, shade };
}

/** The motion family of a collection's own backdrop. */
function collectionFamily(id) {
  return { name: BY_COLLECTION[id] || 'beam', seed: hashSeed(`collection/${id}`) };
}

module.exports = {
  FAMILIES,
  collectionFamily,
  VIDEO,
  FOCUS_PER,
  familyFor,
  renderMotionCover,
  renderMotionFocus,
  renderMotionHero,
  motionVideoFrames,
  _orderMap: orderMap,
  _hashSeed: hashSeed,
};
