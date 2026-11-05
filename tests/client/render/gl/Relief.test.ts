import { describe, expect, it } from "vitest";
import {
  HEIGHT_UNITS_PER_LEVEL,
  hillshadeFactor,
  isShadedTile,
  LAND_BASE_LEVELS,
  lightDirection,
  MAX_RAW_HEIGHT,
  MAX_SHADE,
  MIN_SHADE,
  rawHeightOf,
  reliefNormal,
  sampleHeight,
  shadeChannel,
  smoothHeights,
} from "../../../../src/client/render/gl/terrain/Relief";

const LAND = 0x80;
const SHORE = 0x40;
const OCEAN = 0x20;

function land(magnitude: number): number {
  return LAND | magnitude;
}

describe("rawHeightOf", () => {
  it("puts water at sea level whatever its depth", () => {
    expect(rawHeightOf(OCEAN | 10)).toBe(0);
    expect(rawHeightOf(0)).toBe(0); // lake
    expect(rawHeightOf(SHORE | 3)).toBe(0); // shoreline water
  });

  it("lifts land above the water and grows with elevation", () => {
    expect(rawHeightOf(land(0))).toBe(
      LAND_BASE_LEVELS * HEIGHT_UNITS_PER_LEVEL,
    );
    expect(rawHeightOf(land(10))).toBeGreaterThan(rawHeightOf(land(9)));
    expect(rawHeightOf(land(30))).toBe(MAX_RAW_HEIGHT);
    expect(MAX_RAW_HEIGHT).toBeLessThan(256);
  });

  it("keeps impassable terrain at sea level and unshaded", () => {
    expect(rawHeightOf(land(31))).toBe(0);
    expect(isShadedTile(land(31))).toBe(false);
    expect(isShadedTile(land(5))).toBe(true);
    expect(isShadedTile(OCEAN | 2)).toBe(false);
  });
});

describe("smoothHeights", () => {
  it("leaves a uniform field unchanged", () => {
    const w = 9;
    const h = 7;
    const terrain = new Uint8Array(w * h).fill(land(12));
    const out = new Uint8Array(w * h);
    smoothHeights(terrain, w, h, out);
    for (const v of out) expect(v).toBe(rawHeightOf(land(12)));
  });

  it("blurs a coastline into a ramp that stays within range", () => {
    const w = 12;
    const h = 3;
    const terrain = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 6; x < w; x++) terrain[y * w + x] = land(20);
    const out = new Uint8Array(w * h);
    smoothHeights(terrain, w, h, out);
    const row = Array.from(out.subarray(w, 2 * w));
    // Monotonic ramp from water to land across the coast.
    for (let x = 1; x < w; x++)
      expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]);
    expect(row[0]).toBe(0);
    expect(row[w - 1]).toBe(rawHeightOf(land(20)));
    expect(row[5]).toBeGreaterThan(0);
    expect(row[6]).toBeLessThan(rawHeightOf(land(20)));
  });

  it("matches a full rebuild when only a sub-rect is recomputed", () => {
    const w = 40;
    const h = 30;
    const terrain = new Uint8Array(w * h);
    for (let i = 0; i < terrain.length; i++) {
      terrain[i] = (i * 7919) % 5 === 0 ? OCEAN : land((i * 31) % 30);
    }
    const full = new Uint8Array(w * h);
    smoothHeights(terrain, w, h, full);
    // Change a block (water nuke), then update only the block + blur apron.
    for (let y = 10; y < 14; y++)
      for (let x = 20; x < 25; x++) terrain[y * w + x] = OCEAN;
    const patched = full.slice();
    smoothHeights(terrain, w, h, patched, 18, 8, 27, 16);
    const rebuilt = new Uint8Array(w * h);
    smoothHeights(terrain, w, h, rebuilt);
    expect(Array.from(patched)).toEqual(Array.from(rebuilt));
  });
});

describe("sampleHeight", () => {
  it("returns texel values at texel centres and interpolates between", () => {
    const heights = new Uint8Array([0, 100, 50, 150]); // 2×2
    expect(sampleHeight(heights, 2, 2, 0.5, 0.5)).toBe(0);
    expect(sampleHeight(heights, 2, 2, 1.5, 0.5)).toBe(100);
    expect(sampleHeight(heights, 2, 2, 1, 0.5)).toBe(50);
    expect(sampleHeight(heights, 2, 2, 1, 1)).toBe(75);
    // Clamped outside the map.
    expect(sampleHeight(heights, 2, 2, -5, -5)).toBe(0);
    expect(sampleHeight(heights, 2, 2, 9, 9)).toBe(150);
  });
});

describe("hillshade", () => {
  const light = lightDirection(315, 45);

  it("points the light north-west and up", () => {
    expect(light[0]).toBeLessThan(0); // west
    expect(light[1]).toBeLessThan(0); // north (-y)
    expect(light[2]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.hypot(...light)).toBeCloseTo(1, 6);
  });

  it("computes an upward normal on flat ground", () => {
    const [nx, ny, nz] = reliefNormal(5, 5, 5, 5, 1);
    expect(Math.abs(nx)).toBe(0);
    expect(Math.abs(ny)).toBe(0);
    expect(nz).toBe(1);
  });

  it("tilts the normal away from rising ground", () => {
    // Rising to the east → the normal leans west (-x).
    const n = reliefNormal(0, 10, 0, 0, 0.1);
    expect(n[0]).toBeLessThan(0);
    expect(n[1]).toBeCloseTo(0, 9);
    expect(Math.hypot(...n)).toBeCloseTo(1, 9);
  });

  it("leaves flat ground at exactly the palette colour", () => {
    expect(hillshadeFactor([0, 0, 1], light, 1)).toBeCloseTo(1, 9);
    expect(shadeChannel(200, 1)).toBe(200);
  });

  it("brightens slopes facing the light and darkens slopes facing away", () => {
    // Ground rising toward the south-east faces north-west, into the light.
    const facing = reliefNormal(0, 8, 0, 8, 0.1);
    const away = reliefNormal(8, 0, 8, 0, 0.1);
    expect(hillshadeFactor(facing, light, 1)).toBeGreaterThan(1);
    expect(hillshadeFactor(away, light, 1)).toBeLessThan(1);
    // Strength 0 disables shading.
    expect(hillshadeFactor(away, light, 0)).toBe(1);
  });

  it("clamps so steep slopes never crush or blow out the palette", () => {
    const cliff = reliefNormal(200, 0, 200, 0, 1);
    expect(hillshadeFactor(cliff, light, 1)).toBe(MIN_SHADE);
    const sunny = reliefNormal(0, 3, 0, 3, 1);
    expect(hillshadeFactor(sunny, light, 5)).toBe(MAX_SHADE);
    expect(shadeChannel(250, MAX_SHADE)).toBeLessThanOrEqual(255);
    expect(shadeChannel(100, 0.5)).toBe(50);
  });
});
