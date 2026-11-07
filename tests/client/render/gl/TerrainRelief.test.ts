import { describe, expect, it } from "vitest";
import { ISO_BASE_YAW_DEG } from "../../../../src/client/render/gl/camera/ViewOrbit";
import {
  buildClimateField,
  COAST_SDF_RANGE,
  coldAt,
  decodeCoastSdf,
  updateClimateForFlood,
} from "../../../../src/client/render/gl/terrain/ClimateData";
import { HeightField } from "../../../../src/client/render/gl/terrain/HeightField";
import { HEIGHT_UNITS_PER_LEVEL } from "../../../../src/client/render/gl/terrain/Relief";
import {
  buildReliefHeights,
  elevationProfile,
  RELIEF_APRON,
  ridgedNoise,
} from "../../../../src/client/render/gl/terrain/ReliefHeights";
import {
  ISO_DEFAULT_SUN_DEG,
  SHADOW_AZIMUTHS,
  shadowWeights,
  sunAzimuthDeg,
} from "../../../../src/client/render/gl/terrain/SceneLight";

const LAND = 0x80;
const WATER = 0x00;
const WALL = 0x80 | 31;

/** A map: water all round, a plain, and a mountain range in the middle. */
function terrainMap(w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const border = x < 4 || y < 4 || x >= w - 4 || y >= h - 4;
      if (border) {
        t[i] = WATER;
        continue;
      }
      const d = Math.abs(x - w / 2);
      // Mountains (magnitude up to 28) along the middle, plains elsewhere.
      const mag = d < 6 ? 28 - Math.round(d * 2) : 2;
      t[i] = LAND | mag;
    }
  }
  return t;
}

describe("relief heights", () => {
  it("sits water and walls at sea level and lifts land above it", () => {
    const w = 40;
    const h = 30;
    const t = terrainMap(w, h);
    t[10 * w + 10] = WALL;
    const out = new Float32Array(w * h);
    buildReliefHeights(t, w, h, out);
    expect(out[0]).toBe(0);
    expect(out[10 * w + 10]).toBe(0);
    for (let y = 4; y < h - 4; y++) {
      for (let x = 4; x < w - 4; x++) {
        if (x === 10 && y === 10) continue;
        expect(out[y * w + x]).toBeGreaterThan(0);
      }
    }
  });

  it("raises mountains well above plains, with ridges cut into them", () => {
    const w = 80;
    const h = 60;
    const out = new Float32Array(w * h);
    buildReliefHeights(terrainMap(w, h), w, h, out);
    const levelAt = (x: number, y: number) =>
      out[y * w + x] / HEIGHT_UNITS_PER_LEVEL;
    let ridgeMin = Infinity;
    let ridgeMax = -Infinity;
    for (let y = 15; y < 45; y++) {
      const v = levelAt(w / 2, y);
      ridgeMin = Math.min(ridgeMin, v);
      ridgeMax = Math.max(ridgeMax, v);
      // The range stands far above the plain beside it.
      expect(v).toBeGreaterThan(levelAt(12, y) + 10);
    }
    // Crests and saddles along the range: not one smooth lump.
    expect(ridgeMax - ridgeMin).toBeGreaterThan(1.5);
  });

  it("brings coasts down toward the water", () => {
    const w = 40;
    const h = 30;
    const out = new Float32Array(w * h);
    buildReliefHeights(terrainMap(w, h), w, h, out);
    const coast = out[15 * w + 4];
    const inland = out[15 * w + 10];
    expect(coast).toBeLessThan(inland);
  });

  it("rebuilds a rect exactly as a full build would", () => {
    const w = 60;
    const h = 40;
    const t = terrainMap(w, h);
    const before = new Float32Array(w * h);
    buildReliefHeights(t, w, h, before);
    // Flood a few tiles, then patch around them.
    for (let y = 18; y < 21; y++)
      for (let x = 20; x < 24; x++) t[y * w + x] = WATER;
    const patched = before.slice();
    buildReliefHeights(
      t,
      w,
      h,
      patched,
      20 - RELIEF_APRON,
      18 - RELIEF_APRON,
      24 + RELIEF_APRON,
      21 + RELIEF_APRON,
    );
    const full = new Float32Array(w * h);
    buildReliefHeights(t, w, h, full);
    expect(Array.from(patched)).toEqual(Array.from(full));
  });

  /** Levels at (x, y) of a built field. */
  const levels = (out: Float32Array, w: number) => (x: number, y: number) =>
    out[y * w + x] / HEIGHT_UNITS_PER_LEVEL;
  /** Max - min of `f` over a rect. */
  function spread(
    f: (x: number, y: number) => number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        lo = Math.min(lo, f(x, y));
        hi = Math.max(hi, f(x, y));
      }
    }
    return hi - lo;
  }

  it("keeps plains flat and highlands gentle, and ridges only mountains", () => {
    // Three wide bands of one elevation each: plain, highland, mountain.
    const w = 150;
    const h = 60;
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const mag = x < 50 ? 3 : x < 100 ? 14 : 27;
        t[y * w + x] = LAND | mag;
      }
    }
    const out = new Float32Array(w * h);
    buildReliefHeights(t, w, h, out);
    const at = levels(out, w);
    const plain = spread(at, 8, 8, 42, 52);
    const highland = spread(at, 58, 8, 92, 52);
    const mountain = spread(at, 108, 8, 142, 52);
    expect(plain).toBeLessThan(0.5);
    expect(highland).toBeGreaterThan(plain);
    expect(highland).toBeLessThan(2.5);
    expect(mountain).toBeGreaterThan(3);
    // Each band sits well above the one before it.
    expect(at(75, 30)).toBeGreaterThan(at(25, 30) + 2);
    expect(at(125, 30)).toBeGreaterThan(at(75, 30) + 6);
  });

  it("climbs a quarter level per step on plains, steeply in mountains", () => {
    let prev = elevationProfile(0);
    for (let l = 0.5; l <= 30; l += 0.5) {
      const v = elevationProfile(l);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    const slope = (l: number) =>
      (elevationProfile(l + 0.01) - elevationProfile(l - 0.01)) / 0.02;
    expect(slope(4)).toBeCloseTo(0.25, 6);
    expect(slope(16)).toBeCloseTo(0.6, 6);
    expect(slope(27)).toBeCloseTo(1.35, 6);
  });

  it("slopes the land down to a lake inside the mountains", () => {
    const w = 60;
    const h = 60;
    const t = new Uint8Array(w * h).fill(LAND | 28);
    for (let y = 28; y < 31; y++)
      for (let x = 28; x < 31; x++) t[y * w + x] = WATER;
    const out = new Float32Array(w * h);
    buildReliefHeights(t, w, h, out);
    const at = levels(out, w);
    let far = 0;
    for (let x = 10; x < 20; x++) far += at(x, 10) / 10;
    // The shore sits low: the lake is no pit in the range.
    for (const [x, y] of [
      [27, 29],
      [31, 29],
      [29, 27],
      [29, 31],
    ]) {
      expect(at(x, y)).toBeLessThan(far * 0.35);
    }
    // And the ground rises away from it.
    expect(at(25, 29)).toBeGreaterThan(at(27, 29));
  });

  /** Highlands with a river down column 30. */
  function riverMap(w: number, h: number) {
    const t = new Uint8Array(w * h).fill(LAND | 24);
    const f = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) f[y * w + 30] = 2;
    f[20 * w + 30] = 3;
    return { t, f };
  }

  it("cuts a smooth bed along a river, its banks rising from it", () => {
    const w = 60;
    const h = 50;
    const { t, f } = riverMap(w, h);
    const out = new Float32Array(w * h);
    buildReliefHeights(t, w, h, out, 0, 0, w, h, f);
    const at = levels(out, w);
    const bare = new Float32Array(w * h);
    buildReliefHeights(t, w, h, bare);
    const atBare = levels(bare, w);
    let rough = 0;
    let roughBare = 0;
    for (let y = 6; y < h - 6; y++) {
      rough = Math.max(rough, Math.abs(at(30, y + 1) - at(30, y)));
      roughBare = Math.max(
        roughBare,
        Math.abs(atBare(30, y + 1) - atBare(30, y)),
      );
      // The bed is below the open ground either side.
      expect(at(30, y)).toBeLessThan((at(24, y) + at(36, y)) / 2 + 0.5);
      expect(at(30, y)).toBeLessThanOrEqual(atBare(30, y) + 1e-9);
    }
    // No ridges along the water: the bed is far smoother than the range.
    expect(rough).toBeLessThan(0.05);
    expect(roughBare).toBeGreaterThan(rough * 5);
    // Away from the river nothing changes.
    expect(at(10, 25)).toBe(atBare(10, 25));
  });

  it("rebuilds a rect next to a river exactly as a full build would", () => {
    const w = 60;
    const h = 50;
    const { t, f } = riverMap(w, h);
    const before = new Float32Array(w * h);
    buildReliefHeights(t, w, h, before, 0, 0, w, h, f);
    for (let y = 22; y < 25; y++)
      for (let x = 26; x < 29; x++) t[y * w + x] = WATER;
    const patched = before.slice();
    buildReliefHeights(
      t,
      w,
      h,
      patched,
      26 - RELIEF_APRON,
      22 - RELIEF_APRON,
      29 + RELIEF_APRON,
      25 + RELIEF_APRON,
      f,
    );
    const full = new Float32Array(w * h);
    buildReliefHeights(t, w, h, full, 0, 0, w, h, f);
    expect(Array.from(patched)).toEqual(Array.from(full));
  });

  it("cuts the river beds once the features arrive, as a full build would", () => {
    // Rivers in two corners of a mountain map several blocks wide.
    const w = 220;
    const h = 150;
    const t = terrainMap(w, h);
    const f = new Uint8Array(w * h);
    for (let y = 10; y < 60; y++) f[y * w + 108] = 2;
    for (let x = 150; x < 200; x++) f[120 * w + x] = 3;
    // A GL stand-in: the field only uploads to it.
    const gl = new Proxy(
      {},
      {
        get: (_t, p) =>
          typeof p === "string" && /^[A-Z]/.test(p) ? 0 : () => ({}),
      },
    ) as unknown as WebGL2RenderingContext;
    const field = new HeightField(gl, () => t, t, w, h);
    field.setFeatures(f);
    const full = new Float32Array(w * h);
    buildReliefHeights(t, w, h, full, 0, 0, w, h, f);
    expect(Array.from(field.heights)).toEqual(Array.from(full));
    // And the beds are there.
    const bare = new Float32Array(w * h);
    buildReliefHeights(t, w, h, bare);
    expect(full[30 * w + 108]).toBeLessThan(bare[30 * w + 108]);
  });

  it("uses a fixed noise, so every client builds the same ground", () => {
    expect(ridgedNoise(12.5, 40.25)).toBe(ridgedNoise(12.5, 40.25));
    const v = ridgedNoise(3.3, 7.7);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("climate field: the smooth coast", () => {
  /** Signed coast distance (tiles) bilinear at world (x, y), like the GPU. */
  function coastAt(f: Uint8Array, w: number, h: number, x: number, y: number) {
    const fx = Math.min(w - 1, Math.max(0, x - 0.5));
    const fy = Math.min(h - 1, Math.max(0, y - 0.5));
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const at = (i: number, j: number) =>
      decodeCoastSdf(f[(Math.min(h - 1, j) * w + Math.min(w - 1, i)) * 4]);
    const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
    const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }

  it("keeps every tile on its own side of the coast", () => {
    const w = 30;
    const h = 20;
    const t = terrainMap(w, h);
    // A lone island tile and a one-tile inlet.
    t[2 * w + 15] = LAND | 1;
    t[10 * w + 10] = WATER;
    const f = buildClimateField(t, w, h);
    for (let i = 0; i < w * h; i++) {
      const v = decodeCoastSdf(f[i * 4]);
      if ((t[i] & 0x80) === 0) expect(v, `water ${i}`).toBeLessThan(0);
      else expect(v, `land ${i}`).toBeGreaterThan(0);
    }
    // The island and the inlet are still there when sampled at their centres.
    expect(coastAt(f, w, h, 15.5, 2.5)).toBeGreaterThan(0);
    expect(coastAt(f, w, h, 10.5, 10.5)).toBeLessThan(0);
  });

  it("puts a straight coast on the tile edge", () => {
    const w = 30;
    const h = 20;
    const f = buildClimateField(terrainMap(w, h), w, h);
    // Land starts at x = 4: the line crosses there, mid-coast.
    expect(coastAt(f, w, h, 4.0, 10.5)).toBeCloseTo(0, 1);
    expect(coastAt(f, w, h, 3.5, 10.5)).toBeLessThan(0);
    expect(coastAt(f, w, h, 4.5, 10.5)).toBeGreaterThan(0);
  });

  it("cuts a diagonal coast straight instead of in stair steps", () => {
    const w = 40;
    const h = 40;
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) t[y * w + x] = x + y < 40 ? LAND | 2 : WATER;
    }
    const f = buildClimateField(t, w, h);
    // Along the staircase the zero line stays close to the diagonal x + y =
    // 40 instead of following the tile corners out and in.
    for (let k = 10; k < 30; k++) {
      // Walk across the coast perpendicular to it and find the crossing.
      let prev = coastAt(f, w, h, k - 2, 40 - k - 2);
      for (let s = -2; s <= 2; s += 0.05) {
        const v = coastAt(f, w, h, k + s, 40 - k + s);
        if (prev > 0 && v <= 0) {
          expect(Math.abs(s)).toBeLessThan(0.45);
          break;
        }
        prev = v;
      }
    }
  });

  it("patches a flood exactly as a rebuild would", () => {
    const w = 40;
    const h = 30;
    const t = terrainMap(w, h);
    const f = buildClimateField(t, w, h);
    for (let y = 12; y < 15; y++)
      for (let x = 8; x < 11; x++) t[y * w + x] = WATER;
    updateClimateForFlood(f, t, w, h, [{ x: 8, y: 12, w: 3, h: 3 }]);
    const rebuilt = buildClimateField(t, w, h);
    for (let i = 0; i < w * h; i++)
      expect(f[i * 4], `tile ${i}`).toBe(rebuilt[i * 4]);
  });

  it("saturates far from the coast", () => {
    const w = 40;
    const h = 30;
    const f = buildClimateField(terrainMap(w, h), w, h);
    expect(decodeCoastSdf(f[(15 * w + 20) * 4])).toBeCloseTo(
      COAST_SDF_RANGE,
      1,
    );
  });

  it("is cold only in the northern snow band, coldest at the top", () => {
    expect(coldAt(999, 1000)).toBe(0);
    expect(coldAt(300, 1000)).toBe(0);
    expect(coldAt(10, 1000)).toBeGreaterThan(0.9);
    expect(coldAt(150, 1000)).toBeGreaterThan(0);
    expect(coldAt(150, 1000)).toBeLessThan(coldAt(80, 1000));
  });

  it("makes ground near water wetter than deep inland", () => {
    const w = 200;
    const h = 40;
    const t = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) t[y * w + x] = x < 4 ? WATER : LAND | 2;
    }
    const f = buildClimateField(t, w, h);
    const moist = (x: number) => f[(20 * w + x) * 4 + 1];
    expect(moist(6)).toBeGreaterThan(moist(190));
  });
});

describe("scene light", () => {
  it("keeps the sun at the top-left of the screen at any orbit", () => {
    for (const yaw of [ISO_BASE_YAW_DEG, 45, 135, 225, 17, 278.5]) {
      const sun = sunAzimuthDeg("isometric", yaw, 315);
      // 45 degrees counter-clockwise of up the screen.
      expect((((yaw - sun) % 360) + 360) % 360).toBeCloseTo(45, 9);
    }
    expect(sunAzimuthDeg("isometric", ISO_BASE_YAW_DEG, 0)).toBe(
      ISO_DEFAULT_SUN_DEG,
    );
    // The other views keep the configured sun.
    expect(sunAzimuthDeg("flat", 100, 315)).toBe(315);
    expect(sunAzimuthDeg("terrain3d", 100, 300)).toBe(300);
  });

  it("reads one baked shadow on a baked azimuth, two in between", () => {
    SHADOW_AZIMUTHS.forEach((az, k) => {
      const w = shadowWeights(az);
      const all = [...w.a, ...w.b];
      expect(all[k]).toBeCloseTo(1, 9);
      expect(all.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    });
    // The default view's sun is baked exactly.
    expect(SHADOW_AZIMUTHS).toContain(ISO_DEFAULT_SUN_DEG);
    const mid = shadowWeights(337.5);
    expect(mid.b[3]).toBeCloseTo(0.5, 9);
    expect(mid.a[0]).toBeCloseTo(0.5, 9);
    const odd = shadowWeights(100);
    expect(odd.a[2]).toBeCloseTo(1 - 10 / 45, 9);
    expect(odd.a[3]).toBeCloseTo(10 / 45, 9);
  });
});
