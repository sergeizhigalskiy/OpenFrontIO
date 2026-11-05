import { describe, expect, it } from "vitest";
import {
  DRAPED_QUAD_DIVISIONS,
  drapedQuadVertices,
} from "../../../../src/client/render/gl/terrain/DrapedQuad";

/** Signed area of each triangle in an (x, y) list. */
function triangleAreas(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = v.slice(i, i + 6);
    out.push(((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2);
  }
  return out;
}

describe("draped quad", () => {
  it("tiles the unit square with same-winding triangles", () => {
    const v = drapedQuadVertices();
    const n = DRAPED_QUAD_DIVISIONS;
    expect(v.length).toBe(n * n * 12);
    for (const c of v) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    const areas = triangleAreas(v);
    // The unit quads' winding, and together exactly the square.
    expect(areas.every((a) => a > 0)).toBe(true);
    expect(areas.reduce((s, a) => s + a, 0)).toBeCloseTo(1, 9);
  });

  it("is the plain unit quad at one division", () => {
    expect(Array.from(drapedQuadVertices(1))).toEqual([
      0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1,
    ]);
  });
});
