// Draws the convoy's map sprite. It is original, drawn here in code as a
// pixel grid, so edit this file and rerun:
//
//   npx tsx scripts/genUnitArt.ts
//
// Output (deterministic, so a rerun with no edits changes nothing):
//   resources/atlases/unit-atlas-ext.png  13 px map sprites, one column per
//     UNIT_SPRITES entry. UnitPass uploads these columns right after
//     unit-atlas.png's, so its UNIT_ORDER must list the same types, in the
//     same order, after the train columns.
//
// The base atlas (unit-atlas.png) is left untouched, so branches that change
// it don't conflict with this art.
import fs from "fs";
import path from "path";
import zlib from "zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const ATLAS_DIR = path.join(ROOT, "resources/atlases");

// ---------------------------------------------------------------------------
// Map sprites
// ---------------------------------------------------------------------------

/** Unit atlas cell size; one texel is one map tile (unitSize 13). */
const UNIT_CELL = 13;

/**
 * Gray bands the unit shader swaps for the owner's colors (unit.frag.glsl):
 * O territory color, o halfway to the border color, # border color.
 */
const GRAY: Record<string, number> = { "#": 70, o: 130, O: 180 };

/**
 * Sprites as pixel grids, seen from above with north up (units are not
 * rotated). Each grid is the body only: the script rings it with a one-pixel
 * outline in the border color, as the transport and warship are drawn, and
 * centers it in a 13 px cell. Odd sizes keep the sprite centered on its tile.
 */
const UNIT_SPRITES: { type: string; rows: string[] }[] = [
  {
    // Troops on the move: a covered truck, cab to the right.
    type: "Convoy",
    rows: [
      "ooo#O", //
      "ooo#O",
      "ooo#O",
    ],
  },
];

/** The grid with a one-pixel border-color outline around every body pixel. */
function outlined(rows: string[]): string[] {
  const h = rows.length + 2;
  const w = rows[0].length + 2;
  const at = (x: number, y: number): string =>
    y >= 1 && y <= rows.length && x >= 1 && x <= rows[0].length
      ? rows[y - 1][x - 1]
      : ".";
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const c = at(x, y);
      if (c !== ".") {
        line += c;
      } else if (
        at(x - 1, y) !== "." ||
        at(x + 1, y) !== "." ||
        at(x, y - 1) !== "." ||
        at(x, y + 1) !== "."
      ) {
        line += "#";
      } else {
        line += ".";
      }
    }
    out.push(line);
  }
  return out;
}

function buildUnitAtlas(): Uint8Array {
  const w = UNIT_CELL * UNIT_SPRITES.length;
  const rgba = new Uint8Array(w * UNIT_CELL * 4);
  UNIT_SPRITES.forEach((sprite, col) => {
    for (const row of sprite.rows) {
      if (row.length !== sprite.rows[0].length) {
        throw new Error(`${sprite.type}: rows differ in length`);
      }
    }
    const grid = outlined(sprite.rows);
    if (grid.length > UNIT_CELL || grid[0].length > UNIT_CELL) {
      throw new Error(`${sprite.type}: larger than a ${UNIT_CELL} px cell`);
    }
    const ox = col * UNIT_CELL + Math.floor((UNIT_CELL - grid[0].length) / 2);
    const oy = Math.floor((UNIT_CELL - grid.length) / 2);
    grid.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) {
        if (line[x] === ".") continue;
        const g = GRAY[line[x]];
        if (g === undefined) {
          throw new Error(`${sprite.type}: unknown pixel '${line[x]}'`);
        }
        const i = ((oy + y) * w + ox + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = g;
        rgba[i + 3] = 255;
      }
    });
  });
  return rgba;
}

// ---------------------------------------------------------------------------
// PNG writer
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 8-bit RGBA PNG. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.subarray(y * width * 4, (y + 1) * width * 4)).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function write(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

write(
  path.join(ATLAS_DIR, "unit-atlas-ext.png"),
  encodePng(UNIT_CELL * UNIT_SPRITES.length, UNIT_CELL, buildUnitAtlas()),
);
for (const s of UNIT_SPRITES) {
  console.log(`\n${s.type}\n${outlined(s.rows).join("\n")}`);
}
