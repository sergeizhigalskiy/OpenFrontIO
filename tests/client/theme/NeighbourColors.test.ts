import { colord, type Colord } from "colord";
import { describe, expect, it } from "vitest";
import {
  DisplayColorSeparator,
  fromOklab,
  MIN_NEIGHBOUR_SEPARATION,
  neighbourRadius,
  oklabDistance,
  separateColor,
  toOklab,
} from "../../../src/client/theme/NeighbourColors";

/** Hue in degrees (OKLCh). */
function hueOf(c: Colord): number {
  const o = toOklab(c);
  return (Math.atan2(o.b, o.a) * 180) / Math.PI;
}

function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

describe("OKLab", () => {
  it("round-trips sRGB colours", () => {
    for (const hex of ["#000000", "#ffffff", "#c0392b", "#2e86c1", "#7d8c5a"]) {
      const c = colord(hex);
      const back = fromOklab(toOklab(c)).toRgb();
      const rgb = c.toRgb();
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
    expect(toOklab(colord("#ffffff")).L).toBeCloseTo(1, 3);
    expect(oklabDistance(colord("#808080"), colord("#808080"))).toBe(0);
  });
});

describe("separating a colour from its neighbours", () => {
  it("keeps a colour that already stands apart", () => {
    const base = colord("#2e86c1");
    expect(separateColor(base, [colord("#c0392b"), colord("#f1c40f")])).toBe(
      base,
    );
    expect(separateColor(base, [])).toBe(base);
  });

  it("moves a near twin out of reach, by the mildest change that does", () => {
    const neighbour = colord("#8a8f94");
    const base = colord("#8c9196");
    const out = separateColor(base, [neighbour]);
    expect(oklabDistance(out, neighbour)).toBeGreaterThanOrEqual(
      MIN_NEIGHBOUR_SEPARATION,
    );
    // A mild change: not flipped to the far side of the colour wheel.
    expect(oklabDistance(out, base)).toBeLessThan(0.3);
  });

  it("clears every neighbour at once when it can", () => {
    const reds = ["#c0392b", "#b03a2e", "#cb4335"].map((h) => colord(h));
    const out = separateColor(colord("#c13c2d"), reds);
    for (const r of reds) {
      expect(oklabDistance(out, r)).toBeGreaterThanOrEqual(
        MIN_NEIGHBOUR_SEPARATION,
      );
    }
  });

  it("keeps tribes in their earthy family", () => {
    const tribe = colord("#8b7d6b");
    const out = separateColor(tribe, [tribe, colord("#8f816f")], true);
    expect(oklabDistance(out, tribe)).toBeGreaterThanOrEqual(
      MIN_NEIGHBOUR_SEPARATION,
    );
    expect(hueGap(hueOf(out), hueOf(tribe))).toBeLessThanOrEqual(30);
  });

  it("is deterministic", () => {
    const n = [colord("#777777"), colord("#7a7a7a")];
    expect(separateColor(colord("#787878"), n).toHex()).toBe(
      separateColor(colord("#787878"), n).toHex(),
    );
  });
});

describe("display colours on the map", () => {
  it("keeps bordering players apart, and leaves distant ones alone", () => {
    const sep = new DisplayColorSeparator();
    const grey = colord("#8a8a8a");
    const a = sep.settle("a", 100, 100, grey, true, false, 80);
    const b = sep.settle("b", 130, 100, grey, true, false, 80);
    const far = sep.settle("far", 600, 400, grey, true, false, 80);
    expect(a).toBe(grey);
    expect(oklabDistance(a, b)).toBeGreaterThanOrEqual(
      MIN_NEIGHBOUR_SEPARATION,
    );
    expect(far).toBe(grey);
  });

  it("separates a whole crowd of look-alikes", () => {
    // Ten nations and tribes in near-identical greys around one spot, as on a
    // crowded World map.
    const sep = new DisplayColorSeparator();
    const shown: Colord[] = [];
    for (let i = 0; i < 10; i++) {
      const base = colord({ r: 128 + (i % 3), g: 128, b: 126 + (i % 2) });
      const angle = (i / 10) * 2 * Math.PI;
      shown.push(
        sep.settle(
          `p${i}`,
          300 + 40 * Math.cos(angle),
          300 + 40 * Math.sin(angle),
          base,
          true,
          false,
          200,
        ),
      );
    }
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        expect(
          oklabDistance(shown[i], shown[j]),
          `p${i} vs p${j}`,
        ).toBeGreaterThanOrEqual(MIN_NEIGHBOUR_SEPARATION);
      }
    }
  });

  it("never changes the viewer, teams or cosmetic colours; they anchor others", () => {
    const sep = new DisplayColorSeparator();
    const mine = colord("#3c8d2f");
    expect(sep.settle("me", 50, 50, mine, false, false, 100)).toBe(mine);
    const lookalike = sep.settle(
      "other",
      60,
      50,
      colord("#3d8e30"),
      true,
      false,
      100,
    );
    expect(oklabDistance(lookalike, mine)).toBeGreaterThanOrEqual(
      MIN_NEIGHBOUR_SEPARATION,
    );
    // A fixed colour stays even next to a clash.
    const team = colord("#3d8e30");
    expect(sep.settle("team", 55, 50, team, false, false, 100)).toBe(team);
  });

  it("settles each player once: the colour never changes afterwards", () => {
    const sep = new DisplayColorSeparator();
    const grey = colord("#8a8a8a");
    sep.settle("a", 100, 100, grey, true, false, 80);
    const b = sep.settle("b", 120, 100, grey, true, false, 80);
    // Borders move and new players arrive; b keeps its colour.
    sep.settle("c", 110, 110, grey, true, false, 80);
    expect(sep.settle("b", 500, 500, colord("#ff0000"), true, false, 80)).toBe(
      b,
    );
    expect(sep.displayColor("b")).toBe(b);
    expect(sep.isSettled("b")).toBe(true);
    sep.reset();
    expect(sep.isSettled("b")).toBe(false);
  });

  it("scales the neighbourhood with how crowded the map is", () => {
    const crowded = neighbourRadius(700_000, 500);
    const sparse = neighbourRadius(700_000, 20);
    expect(crowded).toBeLessThan(sparse);
    expect(crowded).toBeGreaterThanOrEqual(48);
    expect(sparse).toBeLessThanOrEqual(450);
  });
});
