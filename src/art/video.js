'use strict';

/**
 * Hero videos: a 6 second MP4 of the folder's poster wall coming alive, for Nuvio
 * TV's Modern home, which plays a folder's heroVideoUrl once when its tile is focused.
 *
 * The wall is the hero still (same posters, same places, same tilt and shading). Its
 * columns drift in turn up and down and ease back, so the video starts and ends
 * exactly on the still that Nuvio shows before and after it, and the hand-over is
 * invisible. The motion moves whole pixels per frame before the tilt, so posters stay
 * crisp instead of shimmering. No text and no audio: Nuvio draws the folder's title
 * logo over the hero itself.
 *
 * The frames are drawn in render.js (heroVideoFrames, plain copies from pre-rotated
 * poster bands, so a frame costs about a millisecond); this module pipes them into
 * ffmpeg (from the ffmpeg-static package, or FFMPEG_PATH), which lays the hero's
 * shading over them and encodes: H.264 High, yuv420p, 1280x720 at 30 fps, about
 * 2 Mbps, with the index at the front (+faststart) so playback starts after the first
 * bytes. A 6 second video takes about 4 seconds on one CPU, inside the 8 second
 * read timeout of Nuvio's player. Set HERO_VIDEO=off to leave hero videos out of the
 * pack.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENCODE = { bitrate: '2000k', maxrate: '2600k', bufsize: '5200k', gop: 60, preset: 'superfast', timeoutMs: 40_000 };
// A healthy video is about 2 MB; anything near Vercel's 4.5 MB response limit is a bug.
const MAX_BYTES = 4 * 1024 * 1024;

let resolved;

/** Path of a usable ffmpeg binary, or null. */
function ffmpegPath() {
  if (resolved !== undefined) return resolved;
  let p = process.env.FFMPEG_PATH || null;
  if (!p) {
    try {
      p = require('ffmpeg-static');
    } catch {
      p = null;
    }
  }
  try {
    resolved = p && fs.statSync(p).isFile() ? executable(p) : null;
  } catch {
    resolved = null;
  }
  return resolved;
}
/**
 * The binary itself when it may be run, else a copy in the temp dir with the execute
 * bit set (a deployment bundle can drop file modes; /tmp is the writable place).
 */
function executable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch {
    const copy = path.join(os.tmpdir(), 'golden-ffmpeg');
    if (!fs.existsSync(copy)) {
      fs.copyFileSync(p, `${copy}.part`);
      fs.chmodSync(`${copy}.part`, 0o755);
      fs.renameSync(`${copy}.part`, copy);
    }
    return copy;
  }
}

/** Are hero videos available (an encoder is present and they are not switched off)? */
function videoEnabled() {
  return process.env.HERO_VIDEO !== 'off' && Boolean(ffmpegPath());
}

/** ffmpeg filter graph: shade every frame (input 0) with the shading image (input 1). */
function filterGraph(count) {
  // The shading is decoded and converted once, then repeated by the loop filter.
  return [
    '[0:v]format=yuv420p[wall]',
    `[1:v]format=yuva420p,loop=loop=${count - 1}:size=1:start=0[shade]`,
    '[wall][shade]overlay=0:0:format=yuv420:shortest=1:eof_action=endall[out]',
  ].join(';');
}

/** ffmpeg arguments for raw RGB frames on stdin and the shading image at `shade`. */
function ffmpegArgs(video, shade, out) {
  const { width, height, fps, count } = video;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-framerate', String(fps), '-i', shade,
    '-filter_complex', filterGraph(count),
    '-map', '[out]', '-frames:v', String(count), '-an',
    '-c:v', 'libx264', '-preset', ENCODE.preset, '-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
    '-b:v', ENCODE.bitrate, '-maxrate', ENCODE.maxrate, '-bufsize', ENCODE.bufsize,
    '-g', String(ENCODE.gop), '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart',
    out,
  ];
}

/**
 * Run ffmpeg, writing `count` frames to its stdin (with backpressure).
 * @returns {Promise<void>}
 */
function run(bin, args, video, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(Object.assign(new Error('ffmpeg timed out'), { code: 'FFMPEG_FAILED' }));
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d;
    });
    child.on('error', (err) => finish(Object.assign(err, { code: 'FFMPEG_FAILED' })));
    child.on('close', (code, signal) => {
      if (code === 0) finish();
      else finish(Object.assign(new Error(`ffmpeg failed (${signal || code}): ${stderr.trim().slice(-400)}`), { code: 'FFMPEG_FAILED' }));
    });
    // ffmpeg may close its input early when it fails; the close handler reports that.
    child.stdin.on('error', () => {});
    (async () => {
      for (let n = 0; n < video.count && !settled; n++) {
        if (!child.stdin.write(video.frame(n))) await new Promise((r) => child.stdin.once('drain', r));
      }
      child.stdin.end();
    })().catch(() => child.kill('SIGKILL'));
  });
}

/**
 * Encode the hero video.
 * @param {{width: number, height: number, fps: number, count: number,
 *   frame: (n: number) => Buffer, shade: Buffer}} video from render.heroVideoFrames
 * @returns {Promise<Buffer>} MP4
 */
async function encodeHeroVideo(video) {
  const bin = ffmpegPath();
  if (!bin) throw Object.assign(new Error('ffmpeg unavailable'), { code: 'FFMPEG_UNAVAILABLE' });
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hero-'));
  try {
    const shade = path.join(dir, 'shade.png');
    const out = path.join(dir, 'hero.mp4');
    await fs.promises.writeFile(shade, video.shade);
    await run(bin, ffmpegArgs(video, shade, out), video, ENCODE.timeoutMs);
    const buf = await fs.promises.readFile(out);
    if (!buf.length || buf.length > MAX_BYTES) throw Object.assign(new Error(`hero video is ${buf.length} bytes`), { code: 'FFMPEG_FAILED' });
    return buf;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reset the cached ffmpeg lookup (tests). */
function _resetFfmpegPath() {
  resolved = undefined;
}

module.exports = { ffmpegPath, videoEnabled, encodeHeroVideo, ffmpegArgs, _resetFfmpegPath, MAX_BYTES };
