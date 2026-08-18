/**
 * The application icon, drawn in code.
 *
 * A PNG encoder is about forty lines once you have `node:zlib`, and writing one
 * is cheaper than adding an image library to a repository whose whole claim is
 * that it has no dependencies. It also means the icon is diffable: changing the
 * mark is a code review, not a binary blob nobody can see into.
 *
 * What it draws is the board: three rows, one of them waiting. That is the
 * product in one glyph — the question this tool answers is "is anything waiting
 * for me", and the answer is a row that is lit while the others are not.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'packages', 'desktop', 'src-tauri', 'icons');

const BG = [0x14, 0x17, 0x1e, 0xff];
const DIM = [0x3a, 0x41, 0x50, 0xff];
const WAIT = [0x38, 0xd9, 0xd9, 0xff];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  // One filter byte (0 = none) per scanline, then RGBA.
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const i = y * stride + 1 + x * 4;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
      raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by a rounded rectangle, sampled 3x3 for soft edges. */
function roundRect(x, y, rx, ry, rw, rh, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      const cx = Math.min(Math.max(px, rx + radius), rx + rw - radius);
      const cy = Math.min(Math.max(py, ry + radius), ry + rh - radius);
      const dx = px - cx;
      const dy = py - cy;
      if (
        px >= rx && px <= rx + rw && py >= ry && py <= ry + rh &&
        dx * dx + dy * dy <= radius * radius + 1e-9
      ) {
        hits++;
      }
    }
  }
  return hits / 9;
}

function mix(base, over, alpha) {
  return [
    Math.round(base[0] + (over[0] - base[0]) * alpha),
    Math.round(base[1] + (over[1] - base[1]) * alpha),
    Math.round(base[2] + (over[2] - base[2]) * alpha),
    255,
  ];
}

function draw(x, y, size) {
  const u = size / 32;
  // The plate.
  const plate = roundRect(x, y, u * 1, u * 1, u * 30, u * 30, u * 7);
  if (plate === 0) return [0, 0, 0, 0];
  let px = mix([0, 0, 0], BG, 1);

  // Three rows. The middle one is lit and longer -- that is the whole story:
  // one project is waiting for you and the others are not.
  const rows = [
    { y: 9, w: 12, colour: DIM },
    { y: 15, w: 18, colour: WAIT },
    { y: 21, w: 9, colour: DIM },
  ];
  for (const r of rows) {
    const cov = roundRect(x, y, u * 7, u * r.y, u * r.w, u * 2.6, u * 1.3);
    if (cov > 0) px = mix(px, r.colour, cov);
  }
  return [px[0], px[1], px[2], Math.round(255 * plate)];
}

mkdirSync(OUT, { recursive: true });
const sizes = {
  '32x32.png': 32,
  '128x128.png': 128,
  '128x128@2x.png': 256,
  'icon.png': 512,
  'Square30x30Logo.png': 30,
  'Square44x44Logo.png': 44,
  'Square71x71Logo.png': 71,
  'Square89x89Logo.png': 89,
  'Square107x107Logo.png': 107,
  'Square142x142Logo.png': 142,
  'Square150x150Logo.png': 150,
  'Square284x284Logo.png': 284,
  'Square310x310Logo.png': 310,
  'StoreLogo.png': 50,
};
for (const [name, size] of Object.entries(sizes)) {
  writeFileSync(join(OUT, name), png(size, draw));
}

// ── .ico ──────────────────────────────────────────────────────────────────
// Windows wants one file with several sizes in it. The ICO container happily
// holds PNGs, which is what every modern tool emits, so no BMP encoder is
// needed.
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 4] = 1;
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}
writeFileSync(
  join(OUT, 'icon.ico'),
  ico([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(size, draw) }))),
);

process.stdout.write(`Simgeler yazıldı: ${OUT}\n  ${Object.keys(sizes).length} png + icon.ico\n`);

// ── .icns ─────────────────────────────────────────────────────────────────
// macOS wants its own container. Modern icns holds PNG payloads directly, one
// per size, each under a four-character type code — so this is the same encoder
// again with a different envelope.
function icns(entries) {
  const parts = [];
  for (const { code, data } of entries) {
    const head = Buffer.alloc(8);
    head.write(code, 0, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    parts.push(head, data);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}
writeFileSync(
  join(OUT, 'icon.icns'),
  icns([
    { code: 'ic11', data: png(32, draw) },   // 16pt @2x
    { code: 'ic12', data: png(64, draw) },   // 32pt @2x
    { code: 'ic07', data: png(128, draw) },
    { code: 'ic13', data: png(256, draw) },  // 128pt @2x
    { code: 'ic09', data: png(512, draw) },
    { code: 'ic14', data: png(512, draw) },  // 256pt @2x
  ]),
);
process.stdout.write('  icon.icns\n');
