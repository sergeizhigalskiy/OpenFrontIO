/**
 * Display colours that keep neighbours apart.
 *
 * The theme hands out player colours from fixed pools (ColorAllocator keeps
 * them distinct while it can, then picks at random), and every tribe shares
 * the flat Bot colour, so on a crowded map two bordering players can be
 * nearly the same shade, and a small one disappears into its neighbour.
 *
 * This adjusts a player's DISPLAY colour on this client only: once, when
 * the player first has a place on the map after the spawn phase, against
 * the players already placed near it (DisplayColorSeparator). A conflict is
 * resolved by the mildest change that clears it, nudging hue and lightness
 * in OKLab (a perceptual space: equal distances look about equally
 * different). A colour, once settled, never changes for the rest of the
 * game, so nothing flickers as borders move. The viewer's own colour, team
 * colours and cosmetic colours are never changed; they only anchor the
 * others. Tribes stay in their earthy family (small hue turns, more
 * lightness and chroma).
 */

import { type Colord, colord } from "colord";

/** A colour in OKLab: L lightness 0-1, a/b opponent axes. */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/**
 * Smallest OKLab distance two neighbours' colours must keep. The fill is
 * drawn translucent over the terrain, about halving it on screen, so this
 * is well above the ~0.02 a viewer can just tell apart.
 */
export const MIN_NEIGHBOUR_SEPARATION = 0.12;

function toLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function fromLinear(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

/** sRGB → OKLab (Björn Ottosson's matrices). */
export function toOklab(color: Colord): Oklab {
  const { r, g, b } = color.toRgb();
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab → linear sRGB, unclamped. */
function oklabToLinear(o: Oklab): [number, number, number] {
  const l = Math.pow(o.L + 0.3963377774 * o.a + 0.2158037573 * o.b, 3);
  const m = Math.pow(o.L - 0.1055613458 * o.a - 0.0638541728 * o.b, 3);
  const s = Math.pow(o.L - 0.0894841775 * o.a - 1.291485548 * o.b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(o: Oklab): boolean {
  const eps = 1e-4;
  return oklabToLinear(o).every((v) => v >= -eps && v <= 1 + eps);
}

/** OKLab → sRGB. */
export function fromOklab(o: Oklab): Colord {
  const [r, g, b] = oklabToLinear(o);
  return colord({ r: fromLinear(r), g: fromLinear(g), b: fromLinear(b) });
}

/** Perceptual distance between two colours (Euclidean in OKLab). */
export function oklabDistance(x: Colord, y: Colord): number {
  const p = toOklab(x);
  const q = toOklab(y);
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/**
 * The colour at lightness L, chroma C and hue h (degrees) in OKLCh, its
 * chroma reduced until it fits sRGB.
 */
function fromOklch(L: number, C: number, h: number): Colord {
  const rad = (h * Math.PI) / 180;
  let lo = 0;
  let hi = C;
  const at = (c: number): Oklab => ({
    L,
    a: c * Math.cos(rad),
    b: c * Math.sin(rad),
  });
  if (inGamut(at(C))) return fromOklab(at(C));
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(at(mid))) lo = mid;
    else hi = mid;
  }
  return fromOklab(at(lo));
}

interface Nudge {
  /** Hue turn, degrees. */
  dh: number;
  /** Lightness shift. */
  dL: number;
  /** Chroma factor. */
  cs: number;
  cost: number;
}

function nudges(
  hues: readonly number[],
  lights: readonly number[],
  chromas: readonly number[],
  hueCost: number,
): Nudge[] {
  const out: Nudge[] = [];
  for (const dh of hues) {
    for (const dL of lights) {
      for (const cs of chromas) {
        const cost =
          Math.abs(dh) / hueCost + Math.abs(dL) / 0.1 + Math.abs(cs - 1) / 0.4;
        out.push({ dh, dL, cs, cost });
      }
    }
  }
  // Mildest first; ties in a fixed order, so every run picks the same one.
  return out
    .map((n, i) => ({ n, i }))
    .sort((p, q) => p.n.cost - q.n.cost || p.i - q.i)
    .map((p) => p.n);
}

const SYMMETRIC = (steps: number[]): number[] => [
  0,
  ...steps.flatMap((s) => [s, -s]),
];

/** Free players: any hue, some lightness, a stronger tint for greys. */
const PLAYER_NUDGES = nudges(
  SYMMETRIC([20, 40, 60, 80, 100, 120, 140, 160]).concat([180]),
  SYMMETRIC([0.07, 0.14, 0.21]),
  [1, 1.8],
  60,
);
/** Tribes: their earthy family, so mostly lightness and chroma. */
const FAMILY_NUDGES = nudges(
  SYMMETRIC([12, 24]),
  SYMMETRIC([0.06, 0.12, 0.18]),
  [1, 0.65, 1.4],
  30,
);

/**
 * Display colour for `base` that keeps at least MIN_NEIGHBOUR_SEPARATION
 * from every colour in `neighbours`: `base` itself when it already does,
 * else the mildest nudge that does, else the nudge farthest from its
 * nearest neighbour. `family` keeps it near its hue (tribes).
 */
export function separateColor(
  base: Colord,
  neighbours: readonly Colord[],
  family = false,
): Colord {
  if (neighbours.length === 0) return base;
  const near = neighbours.map(toOklab);
  const clearance = (c: Colord): number => {
    const o = toOklab(c);
    let min = Infinity;
    for (const n of near) {
      min = Math.min(min, Math.hypot(o.L - n.L, o.a - n.a, o.b - n.b));
    }
    return min;
  };
  if (clearance(base) >= MIN_NEIGHBOUR_SEPARATION) return base;
  const o = toOklab(base);
  const C = Math.hypot(o.a, o.b);
  const h = (Math.atan2(o.b, o.a) * 180) / Math.PI;
  let best = base;
  let bestClear = clearance(base);
  for (const n of family ? FAMILY_NUDGES : PLAYER_NUDGES) {
    const L = Math.min(0.88, Math.max(0.32, o.L + n.dL));
    // A grey has no hue to turn: give it a little colour to work with.
    const c = Math.max(C, n.dh !== 0 || n.cs !== 1 ? 0.07 : 0) * n.cs;
    const candidate = fromOklch(L, c, h + n.dh);
    const cl = clearance(candidate);
    if (cl >= MIN_NEIGHBOUR_SEPARATION) return candidate;
    if (cl > bestClear) {
      bestClear = cl;
      best = candidate;
    }
  }
  return best;
}

/**
 * How far apart (tiles) two players' centres may be for their colours to
 * be kept apart: a few typical territory widths, so players that start
 * near each other, and so will border each other, never look alike.
 */
export function neighbourRadius(landTiles: number, players: number): number {
  const typicalWidth = Math.sqrt(landTiles / Math.max(1, players));
  return Math.min(450, Math.max(48, 2.6 * typicalWidth));
}

interface Settled {
  x: number;
  y: number;
  color: Colord;
}

/**
 * Settles each player's display colour once, against the players already
 * settled within a radius, and remembers it for the rest of the game.
 */
export class DisplayColorSeparator {
  private settled = new Map<string, Settled>();

  isSettled(id: string): boolean {
    return this.settled.has(id);
  }

  /** The settled display colour, or undefined before settle(). */
  displayColor(id: string): Colord | undefined {
    return this.settled.get(id)?.color;
  }

  /**
   * Settle `id`'s display colour at map position (x, y): `base` unchanged
   * when it isn't `adjustable` (the viewer, teams, cosmetic colours) or
   * already stands apart from its settled neighbours within `radius`, else
   * the mildest separating nudge (separateColor). Later calls return the
   * same colour.
   */
  settle(
    id: string,
    x: number,
    y: number,
    base: Colord,
    adjustable: boolean,
    family: boolean,
    radius: number,
  ): Colord {
    const known = this.settled.get(id);
    if (known !== undefined) return known.color;
    let color = base;
    if (adjustable) {
      const r2 = radius * radius;
      const near: Colord[] = [];
      for (const s of this.settled.values()) {
        const dx = s.x - x;
        const dy = s.y - y;
        if (dx * dx + dy * dy <= r2) near.push(s.color);
      }
      color = separateColor(base, near, family);
    }
    this.settled.set(id, { x, y, color });
    return color;
  }

  /** Forget every settled colour (a theme change re-settles them). */
  reset(): void {
    this.settled.clear();
  }
}
