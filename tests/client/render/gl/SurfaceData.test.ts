import { describe, expect, it } from "vitest";
import {
  buildSurfaceField,
  COAST_UNITS,
  decodeWaterDepth,
  ELEVATION_UNITS,
  encodeWaterDepth,
  NEAR_FOREST,
  NEAR_WATERWAY,
  packTerrainFeatures,
  squaredDistanceTransform,
  updateSurfaceForFlood,
  WALL_UNITS,
  WATER_DEPTH_RANGE,
} from "../../../../src/client/render/gl/terrain/SurfaceData";

const LAND = 0x80;
const WALL = 0x80 | 31;
const WATER = 0x20; // ocean, magnitude 0

function land(level: number): number {
  return LAND | level;
}

/** A w×h map from a function of (x, y). */
function map(w: number, h: number, at: (x: number, y: number) => number) {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) t[y * w + x] = at(x, y);
  return t;
}

const R = 0;
const G = 1;
const B = 2;
const A = 3;
const ch = (field: Uint8Array, w: number, x: number, y: number, c: number) =>
  field[(y * w + x) * 4 + c];

describe("squaredDistanceTransform", () => {
  it("matches a brute-force search", () => {
    const w = 23;
    const h = 17;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const src = new Uint8Array(w * h).map(() => (rand() < 0.06 ? 1 : 0));
    const out = new Float32Array(w * h);
    squaredDistanceTransform(src, w, h, out);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity;
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            if (src[j * w + i])
              best = Math.min(best, (x - i) ** 2 + (y - j) ** 2);
          }
        }
        expect(out[y * w + x]).toBe(best);
      }
    }
  });

  it("is Infinity everywhere without a source", () => {
    const out = new Float32Array(12);
    squaredDistanceTransform(new Uint8Array(12), 4, 3, out);
    expect([...out].every((v) => v === Infinity)).toBe(true);
  });
});

describe("buildSurfaceField", () => {
  // Land on the left half (x < 10), sea on the right.
  const w = 40;
  const h = 6;
  const coast = map(w, h, (x) => (x < 10 ? land(5) : WATER));
  const field = buildSurfaceField(coast, w, h);

  it("measures water depth from the shore, growing out to sea", () => {
    expect(ch(field, w, 9, 3, R)).toBe(0); // land
    expect(decodeWaterDepth(ch(field, w, 10, 3, R))).toBeCloseTo(0.5, 0);
    let last = 0;
    for (let x = 10; x < w; x++) {
      const r = ch(field, w, x, 3, R);
      expect(r).toBeGreaterThan(last);
      last = r;
    }
    expect(decodeWaterDepth(ch(field, w, 30, 3, R))).toBeCloseTo(20.5, 0);
  });

  it("measures land's distance to the water", () => {
    expect(ch(field, w, 10, 3, G)).toBe(0); // water
    expect(ch(field, w, 9, 3, G)).toBe(0.5 * COAST_UNITS);
    expect(ch(field, w, 6, 3, G)).toBe(3.5 * COAST_UNITS);
  });

  it("keeps the palette elevation at the land's level up to the coast", () => {
    for (let x = 0; x < 10; x++) {
      expect(ch(field, w, x, 3, A)).toBe(5 * ELEVATION_UNITS);
    }
  });

  it("marks maps without walls as far from any", () => {
    for (let i = 0; i < w * h; i++) expect(field[i * 4 + B]).toBe(255);
  });

  it("signs the wall distance and doesn't count walls as shore", () => {
    // Land | wall (x 10-11) | sea.
    const t = map(w, h, (x) => (x < 10 ? land(5) : x < 12 ? WALL : WATER));
    const f = buildSurfaceField(t, w, h);
    expect(ch(f, w, 9, 3, B)).toBe(128 + 0.5 * WALL_UNITS);
    expect(ch(f, w, 10, 3, B)).toBe(128 - 0.5 * WALL_UNITS);
    expect(ch(f, w, 12, 3, B)).toBe(128 + 0.5 * WALL_UNITS);
    // Walls are void, not shore: the sea beside one gets no shallows.
    expect(decodeWaterDepth(ch(f, w, 12, 3, R))).toBeGreaterThan(20);
    // Land next to the wall isn't a beach.
    expect(ch(f, w, 9, 3, G)).toBeGreaterThan(2 * COAST_UNITS);
    // The wall doesn't drag the land's palette elevation down.
    expect(ch(f, w, 9, 3, A)).toBe(5 * ELEVATION_UNITS);
  });
});

describe("encodeWaterDepth", () => {
  it("round-trips within a step and saturates at the range", () => {
    for (const d of [0, 0.5, 1, 3, 10, 40]) {
      expect(Math.abs(decodeWaterDepth(encodeWaterDepth(d)) - d)).toBeLessThan(
        0.6,
      );
    }
    expect(encodeWaterDepth(WATER_DEPTH_RANGE * 3)).toBe(255);
  });
});

describe("updateSurfaceForFlood", () => {
  it("patches the fields around tiles that turned to water", () => {
    const w = 30;
    const h = 30;
    const before = map(w, h, (x) => (x < 15 ? land(8) : WATER));
    const field = buildSurfaceField(before, w, h);
    // A water nuke floods a 3×3 crater well inland.
    const after = before.slice();
    for (let y = 10; y < 13; y++)
      for (let x = 5; x < 8; x++) after[y * w + x] = WATER;
    const dirty = updateSurfaceForFlood(field, after, w, h, [
      { x: 5, y: 10, w: 3, h: 3 },
    ]);
    expect(dirty).toHaveLength(1);
    // The crater is water now, shallow, with land right beside it.
    expect(ch(field, w, 6, 11, R)).toBeGreaterThan(0);
    expect(decodeWaterDepth(ch(field, w, 6, 11, R))).toBeLessThan(2);
    expect(ch(field, w, 6, 11, G)).toBe(0);
    // The land around it is now on a coast.
    expect(ch(field, w, 4, 11, G)).toBe(0.5 * COAST_UNITS);
    // Its rim's palette elevation is unchanged (land-only average).
    expect(ch(field, w, 4, 11, A)).toBe(8 * ELEVATION_UNITS);
    // Nothing new floods on a second pass.
    expect(
      updateSurfaceForFlood(field, after, w, h, [{ x: 5, y: 10, w: 3, h: 3 }]),
    ).toEqual([]);
  });
});

describe("packTerrainFeatures", () => {
  it("keeps each tile's feature and flags what lies around it", () => {
    const w = 5;
    const h = 5;
    const f = new Uint8Array(w * h);
    f[2 * w + 2] = 1; // forest in the middle
    f[0] = 2; // river in a corner
    const packed = packTerrainFeatures(f, w, h);
    expect(packed[2 * w + 2] & 3).toBe(1);
    expect(packed[1 * w + 1] & NEAR_FOREST).toBe(NEAR_FOREST);
    expect(packed[4] & NEAR_FOREST).toBe(0);
    expect(packed[0] & 3).toBe(2);
    expect(packed[1 * w + 1] & NEAR_WATERWAY).toBe(NEAR_WATERWAY);
    expect(packed[2 * w + 2] & NEAR_WATERWAY).toBe(0);
  });
});
