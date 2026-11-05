// Draws the art for the naval-defense and conventional-war units: map
// sprites, structure glyphs and HUD icons. All of it is original, drawn here
// in code (pixel grids and simple vector shapes), so edit this file and rerun:
//
//   npx tsx scripts/genUnitArt.ts
//
// Outputs (deterministic, so a rerun with no edits changes nothing):
//   resources/atlases/unit-atlas-ext.png  13 px map sprites, one column per
//     UNIT_SPRITES entry. UnitPass uploads these columns right after
//     unit-atlas.png's, so its UNIT_ORDER must list the same types, in the
//     same order, after the train columns.
//   resources/atlases/icon-atlas-ext.png  64 px white structure glyphs, one
//     column per STRUCTURE_GLYPHS entry. StructurePass uploads them right
//     after icon-atlas.png's; its STRUCTURE_ORDER lists them after the silo.
//   resources/images/<Name>IconWhite.svg  HUD icons for the build menu, the
//     radial menu and the unit bar: white glyphs like the other *White.svg.
//
// The base atlases (unit-atlas.png, icon-atlas.png) are left untouched, so
// branches that change them don't conflict with this art.
import fs from "fs";
import path from "path";
import zlib from "zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const ATLAS_DIR = path.join(ROOT, "resources/atlases");
const IMAGE_DIR = path.join(ROOT, "resources/images");

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
  {
    // Bomber: swept wings, a light spine, a small tailplane.
    type: "Airstrike",
    rows: [
      "....O....",
      "....O....",
      "...oOo...",
      "..ooOoo..",
      ".oooOooo.",
      "ooooOoooo",
      "oo..O..oo",
      "....O....",
      "...oOo...",
    ],
  },
  {
    // Transport plane: straight wings and a wide cargo body.
    type: "Airdrop",
    rows: [
      "...OOO...",
      "...OOO...",
      "oooOOOooo",
      "oooOOOooo",
      "...OOO...",
      "...OOO...",
      "...OOO...",
      ".ooOOOoo.",
      "....O....",
    ],
  },
  {
    // Quadcopter: four rotors on a cross.
    type: "Drone",
    rows: [
      "OO.OO", //
      "OOoOO",
      ".ooo.",
      "OOoOO",
      "OO.OO",
    ],
  },
  {
    // Cruise missile: long thin body, stub wings, small tail fins.
    type: "Cruise Missile",
    rows: [
      ".O.", //
      ".O.",
      ".o.",
      "ooo",
      ".o.",
      ".o.",
      ".o.",
      "ooo",
      "o.o",
    ],
  },
  {
    // Ballistic missile: fat body, light nose and spine, wide fins.
    type: "Ballistic Missile",
    rows: [
      "..O..",
      ".OOO.",
      ".oOo.",
      ".oOo.",
      ".oOo.",
      ".oOo.",
      ".oOo.",
      "ooooo",
      "o.o.o",
    ],
  },
  {
    // Cluster missile: a head splitting into three submunitions.
    type: "Cluster Missile",
    rows: [
      "..O..",
      "O.O.O",
      "O.O.O",
      "OoooO",
      ".ooo.",
      ".ooo.",
      ".ooo.",
      "ooooo",
      "o.o.o",
    ],
  },
  {
    // Cluster warhead: a small falling bomblet.
    type: "Cluster Warhead",
    rows: [
      "O", //
      "o",
      "o",
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
// Vector icons
// ---------------------------------------------------------------------------

type Pt = readonly [number, number];
type Shape =
  | { kind: "poly"; pts: Pt[] }
  | { kind: "circle"; c: Pt; r: number }
  | { kind: "ellipse"; c: Pt; rx: number; ry: number; rot: number };
/** Filled shapes minus cut-out shapes. An icon is the union of its layers. */
interface Layer {
  add: Shape[];
  cut?: Shape[];
}
type Icon = Layer[];

// All icons are drawn in a 64x64 box, y down, kept within 4..60.
const poly = (...pts: Pt[]): Shape => ({ kind: "poly", pts });
const circle = (cx: number, cy: number, r: number): Shape => ({
  kind: "circle",
  c: [cx, cy],
  r,
});
const ellipse = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotDeg = 0,
): Shape => ({ kind: "ellipse", c: [cx, cy], rx, ry, rot: rad(rotDeg) });
const rect = (x: number, y: number, w: number, h: number): Shape =>
  poly([x, y], [x + w, y], [x + w, y + h], [x, y + h]);

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Points along a circular arc, angles in degrees (0 = east, 90 = south). */
function arc(
  cx: number,
  cy: number,
  r: number,
  fromDeg: number,
  toDeg: number,
  steps = 16,
): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = rad(fromDeg + ((toDeg - fromDeg) * i) / steps);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** A thick line through `pts` with round joins and caps. */
function stroke(pts: Pt[], width: number): Shape[] {
  const out: Shape[] = [];
  const h = width / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len === 0) continue;
    const nx = (-(by - ay) / len) * h;
    const ny = ((bx - ax) / len) * h;
    out.push(
      poly(
        [ax + nx, ay + ny],
        [bx + nx, by + ny],
        [bx - nx, by - ny],
        [ax - nx, ay - ny],
      ),
    );
  }
  for (const [x, y] of pts) out.push(circle(x, y, h));
  return out;
}

/** Rotates and moves shapes: rotate by `deg` about `about`, then shift. */
function place(
  shapes: Shape[],
  deg: number,
  about: Pt,
  shift: Pt = [0, 0],
  scale = 1,
): Shape[] {
  const a = rad(deg);
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const tf = ([x, y]: Pt): Pt => {
    const dx = (x - about[0]) * scale;
    const dy = (y - about[1]) * scale;
    return [
      about[0] + dx * cos - dy * sin + shift[0],
      about[1] + dx * sin + dy * cos + shift[1],
    ];
  };
  return shapes.map((s): Shape => {
    switch (s.kind) {
      case "poly":
        return { kind: "poly", pts: s.pts.map(tf) };
      case "circle":
        return { kind: "circle", c: tf(s.c), r: s.r * scale };
      case "ellipse":
        return {
          kind: "ellipse",
          c: tf(s.c),
          rx: s.rx * scale,
          ry: s.ry * scale,
          rot: s.rot + a,
        };
    }
  });
}

/** A mirror-symmetric outline from its right half (x >= cx), top to bottom. */
function mirrored(cx: number, right: Pt[]): Shape {
  const left = right
    .slice()
    .reverse()
    .map(([x, y]): Pt => [2 * cx - x, y]);
  return poly(...right, ...left);
}

/** Top-down jet, nose up, centered on (cx, cy), `len` long. */
function jet(cx: number, cy: number, len: number): Shape {
  const s = len / 2;
  const p = (x: number, y: number): Pt => [cx + x * s, cy + y * s];
  return mirrored(cx, [
    p(0, -1),
    p(0.07, -0.9),
    p(0.1, -0.72),
    p(0.1, -0.28),
    p(0.95, 0.22),
    p(0.95, 0.38),
    p(0.1, 0.2),
    p(0.1, 0.58),
    p(0.4, 0.82),
    p(0.4, 0.96),
    p(0.08, 0.92),
    p(0, 0.98),
  ]);
}

/** Eight-point burst (a flak shell bursting) centered on (cx, cy). */
function burst(cx: number, cy: number, r: number): Shape {
  const pts: Pt[] = [];
  for (let i = 0; i < 16; i++) {
    const a = rad(i * 22.5 - 90);
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return poly(...pts);
}

/** A bomb falling nose down: teardrop body with a tail fin. */
function bomb(cx: number, cy: number, r: number): Shape[] {
  return [
    ellipse(cx, cy, r, r * 1.5),
    poly(
      [cx - r * 0.9, cy - r * 2.3],
      [cx + r * 0.9, cy - r * 2.3],
      [cx + r * 0.35, cy - r],
      [cx - r * 0.35, cy - r],
    ),
  ];
}

/** Points along a sine wave from x0 to x1 around baseline y. */
function wave(
  x0: number,
  x1: number,
  y: number,
  amp: number,
  periods: number,
): Pt[] {
  const pts: Pt[] = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push([
      x0 + (x1 - x0) * t,
      y + amp * Math.sin(t * periods * 2 * Math.PI),
    ]);
  }
  return pts;
}

/** Top-down bomber, nose up: wide swept wings and engine pods. */
function bomber(cx: number, cy: number, len: number): Shape {
  const s = len / 2;
  const p = (x: number, y: number): Pt => [cx + x * s, cy + y * s];
  return mirrored(cx, [
    p(0, -1),
    p(0.08, -0.88),
    p(0.12, -0.6),
    p(0.12, -0.22),
    p(0.62, 0.12),
    p(0.62, -0.02),
    p(0.72, -0.02),
    p(0.72, 0.19),
    p(1.25, 0.55),
    p(1.25, 0.68),
    p(0.12, 0.42),
    p(0.12, 0.66),
    p(0.48, 0.88),
    p(0.48, 0.98),
    p(0.08, 0.94),
    p(0, 1),
  ]);
}

const ICONS: Record<string, { title: string; icon: Icon }> = {
  CoastalBattery: {
    title: "Coastal battery",
    icon: [
      {
        add: [
          // Fort wall with battlements.
          rect(6, 22, 36, 26),
          rect(6, 14, 8, 9),
          rect(20, 14, 8, 9),
          rect(34, 14, 8, 9),
          // Heavy gun out of the embrasure, over the sea.
          rect(40, 27, 18, 6.5),
          rect(54, 25.5, 5, 9.5),
          // Waves at its foot.
          ...stroke(wave(5, 59, 55, 3.2, 3), 3.6),
        ],
        cut: [rect(13, 33, 7, 15)],
      },
    ],
  },
  Minefield: {
    title: "Minefield",
    icon: [
      {
        add: [
          circle(32, 28, 14),
          // Contact horns.
          ...[0, 45, 90, 135, 180, 225, 270, 315].flatMap((deg) => {
            const a = rad(deg - 90);
            const tip: Pt = [32 + 20 * Math.cos(a), 28 + 20 * Math.sin(a)];
            return [
              ...stroke([[32, 28], tip], 3.6),
              circle(tip[0], tip[1], 3.6),
            ];
          }),
          // Mooring chain down to the waterline.
          ...stroke(
            [
              [32, 42],
              [32, 52],
            ],
            3,
          ),
          ...stroke(wave(5, 59, 56, 3.2, 3), 3.4),
        ],
        // A glint so the sphere reads as round.
        cut: stroke(arc(32, 28, 8.5, 200, 260, 8), 2.6),
      },
    ],
  },
  Airbase: {
    title: "Airbase",
    icon: [
      // A jet over its runway, which has a dashed centerline.
      { add: [jet(32, 25, 42)] },
      {
        add: [rect(15, 50, 34, 9)],
        cut: [
          rect(18, 53.4, 6, 2.2),
          rect(29, 53.4, 6, 2.2),
          rect(40, 53.4, 6, 2.2),
        ],
      },
    ],
  },
  FlakGun: {
    title: "Flak gun",
    icon: [
      {
        add: [
          // Twin barrels angled at the sky.
          ...place(
            [rect(28, 13, 4.2, 32), rect(34.5, 13, 4.2, 32)],
            38,
            [33, 44],
          ),
          // Gun shield and mount.
          ...place([rect(25, 33, 17, 9)], 38, [33, 44]),
          circle(31, 45, 8),
          poly([16, 52], [24, 46], [40, 46], [48, 52]),
          rect(10, 52, 44, 6),
        ],
      },
      // Shell bursts.
      { add: [burst(15, 15, 9), burst(31, 7.5, 5), burst(8.5, 31, 4.5)] },
    ],
  },
  Airstrike: {
    title: "Airstrike",
    icon: [
      { add: [bomber(32, 22, 38)] },
      {
        add: [...bomb(18, 52, 3.4), ...bomb(32, 56, 3.4), ...bomb(46, 52, 3.4)],
      },
    ],
  },
  Airdrop: {
    title: "Airdrop",
    icon: [
      {
        // Canopy with a scalloped hem.
        add: [poly(...arc(32, 27, 24, 180, 360, 24))],
        cut: [
          circle(16, 28.5, 8.3),
          circle(32, 28.5, 8.3),
          circle(48, 28.5, 8.3),
        ],
      },
      {
        add: [
          // Shroud lines.
          ...stroke(
            [
              [9, 26],
              [29, 44],
            ],
            2,
          ),
          ...stroke(
            [
              [55, 26],
              [35, 44],
            ],
            2,
          ),
          ...stroke(
            [
              [24, 25],
              [31, 42],
            ],
            2,
          ),
          ...stroke(
            [
              [40, 25],
              [33, 42],
            ],
            2,
          ),
          // Paratrooper.
          circle(32, 42.5, 4),
          poly([27, 47], [37, 47], [36, 55], [28, 55]),
          ...stroke(
            [
              [29.5, 54],
              [27, 60],
            ],
            3,
          ),
          ...stroke(
            [
              [34.5, 54],
              [37, 60],
            ],
            3,
          ),
        ],
      },
    ],
  },
  Drone: {
    title: "Drone",
    icon: [
      {
        add: [
          ...stroke(
            [
              [16, 16],
              [48, 48],
            ],
            5,
          ),
          ...stroke(
            [
              [48, 16],
              [16, 48],
            ],
            5,
          ),
          poly([24, 28], [32, 22], [40, 28], [40, 38], [32, 43], [24, 38]),
          circle(15, 15, 10),
          circle(49, 15, 10),
          circle(15, 49, 10),
          circle(49, 49, 10),
        ],
        cut: [
          circle(15, 15, 6.4),
          circle(49, 15, 6.4),
          circle(15, 49, 6.4),
          circle(49, 49, 6.4),
          circle(32, 33, 3),
        ],
      },
      // Rotor hubs.
      {
        add: [
          circle(15, 15, 2.4),
          circle(49, 15, 2.4),
          circle(15, 49, 2.4),
          circle(49, 49, 2.4),
        ],
      },
    ],
  },
  CruiseMissile: {
    title: "Cruise missile",
    icon: [
      {
        add: place(
          [
            // Long body and ogive nose.
            poly(
              [17, 28.5],
              [48, 28.5],
              [54, 29.5],
              [58, 31.2],
              [61, 33],
              [58, 34.8],
              [54, 36.5],
              [48, 37.5],
              [17, 37.5],
            ),
            // Stub wings, swept back.
            poly([33, 36], [39, 36], [32, 44], [28, 44]),
            poly([33, 30], [39, 30], [32, 22], [28, 22]),
            // Tail fins.
            poly([17, 30], [22, 30], [17, 23], [14, 23]),
            poly([17, 36], [22, 36], [17, 43], [14, 43]),
            // Exhaust flame.
            poly([15, 30.5], [9, 31.5], [2, 33], [9, 34.5], [15, 35.5]),
          ],
          -30,
          [32, 33],
        ),
        cut: place([rect(45, 28, 2.6, 10)], -30, [32, 33]),
      },
    ],
  },
  BallisticMissile: {
    title: "Ballistic missile",
    icon: [
      {
        add: [
          // Nose cone and body.
          mirrored(32, [
            [32, 4],
            [35, 8],
            [38, 14],
            [39, 19],
            [39, 46],
          ]),
          // Fins.
          poly([39, 32], [47, 43], [47, 51], [39, 46]),
          poly([25, 32], [17, 43], [17, 51], [25, 46]),
          // Nozzle and flame.
          poly([27, 46], [37, 46], [38, 50], [26, 50]),
          mirrored(32, [
            [36, 52],
            [37, 56],
            [32, 62],
          ]),
        ],
        // Stage joints.
        cut: [rect(24, 19, 16, 2.6), rect(24, 33, 16, 2.6)],
      },
    ],
  },
  ClusterMissile: {
    title: "Cluster missile",
    icon: [
      {
        // Carrier body climbing to the upper right, its nose open where the
        // warheads left.
        add: place(
          [
            rect(26, 31, 12, 22),
            poly([26, 31], [26, 26], [32, 32], [38, 26], [38, 31]),
            poly([26, 43], [20, 51], [20, 56], [26, 52]),
            poly([38, 43], [44, 51], [44, 56], [38, 52]),
            poly([28, 53], [36, 53], [37, 57], [27, 57]),
          ],
          40,
          [32, 44],
          [-11, 3],
        ),
      },
      // Submunitions spraying out ahead of it.
      {
        add: [
          circle(36, 20, 4.6),
          circle(46, 28, 4.6),
          circle(30, 8, 3.8),
          circle(47, 14, 3.8),
          circle(57, 23, 3.4),
          circle(58, 8, 3),
        ],
      },
    ],
  },
};

/** Structure glyphs for the icon atlas, in StructurePass's order. */
const STRUCTURE_GLYPHS = ["CoastalBattery", "Airbase", "FlakGun"] as const;

/** Icon atlas cell size and where the 64-unit design box lands in a cell. */
const ICON_CELL = 64;
const GLYPH_SCALE = 0.75;
const GLYPH_OFFSET = 8;

function shapeContains(s: Shape, x: number, y: number): boolean {
  switch (s.kind) {
    case "circle": {
      const dx = x - s.c[0];
      const dy = y - s.c[1];
      return dx * dx + dy * dy <= s.r * s.r;
    }
    case "ellipse": {
      const dx = x - s.c[0];
      const dy = y - s.c[1];
      const cos = Math.cos(-s.rot);
      const sin = Math.sin(-s.rot);
      const u = (dx * cos - dy * sin) / s.rx;
      const v = (dx * sin + dy * cos) / s.ry;
      return u * u + v * v <= 1;
    }
    case "poly": {
      // Nonzero winding, as SVG fills by default.
      let wn = 0;
      const pts = s.pts;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yj <= y) {
          if (yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) wn++;
        } else if (yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) {
          wn--;
        }
      }
      return wn !== 0;
    }
  }
}

function iconContains(icon: Icon, x: number, y: number): boolean {
  return icon.some(
    (layer) =>
      layer.add.some((s) => shapeContains(s, x, y)) &&
      !(layer.cut ?? []).some((s) => shapeContains(s, x, y)),
  );
}

/**
 * Draws `icon` white into an RGBA buffer `bufW` wide: design unit (x, y)
 * lands on pixel (ox + x * scale, oy + y * scale), over a size x size area.
 * 8x8 supersampling per pixel for anti-aliased edges.
 */
function rasterize(
  icon: Icon,
  rgba: Uint8Array,
  bufW: number,
  ox: number,
  oy: number,
  size: number,
  scale: number,
  offset: number,
): void {
  const ss = 8;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss - offset) / scale;
          const y = (py + (sy + 0.5) / ss - offset) / scale;
          if (iconContains(icon, x, y)) hits++;
        }
      }
      const i = ((oy + py) * bufW + ox + px) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
      rgba[i + 3] = Math.round((hits / (ss * ss)) * 255);
    }
  }
}

function buildIconAtlas(): Uint8Array {
  const w = ICON_CELL * STRUCTURE_GLYPHS.length;
  const rgba = new Uint8Array(w * ICON_CELL * 4);
  STRUCTURE_GLYPHS.forEach((name, col) => {
    rasterize(
      ICONS[name].icon,
      rgba,
      w,
      col * ICON_CELL,
      0,
      ICON_CELL,
      GLYPH_SCALE,
      GLYPH_OFFSET,
    );
  });
  return rgba;
}

// ---------------------------------------------------------------------------
// SVG and PNG writers
// ---------------------------------------------------------------------------

const num = (n: number): string => String(Math.round(n * 100) / 100);

function pathData(s: Shape): string {
  switch (s.kind) {
    case "poly":
      return `M${s.pts.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}Z`;
    case "circle": {
      const [cx, cy] = s.c;
      const r = num(s.r);
      return `M${num(cx - s.r)} ${num(cy)}a${r} ${r} 0 1 0 ${num(2 * s.r)} 0a${r} ${r} 0 1 0 ${num(-2 * s.r)} 0Z`;
    }
    case "ellipse": {
      const dx = s.rx * Math.cos(s.rot);
      const dy = s.rx * Math.sin(s.rot);
      const [cx, cy] = s.c;
      const deg = num((s.rot * 180) / Math.PI);
      const a = `${num(s.rx)} ${num(s.ry)} ${deg} 1 0`;
      return `M${num(cx - dx)} ${num(cy - dy)}A${a} ${num(cx + dx)} ${num(cy + dy)}A${a} ${num(cx - dx)} ${num(cy - dy)}Z`;
    }
  }
}

function toSvg(title: string, icon: Icon): string {
  let defs = "";
  let body = "";
  icon.forEach((layer, i) => {
    const paths = layer.add.map((s) => `<path d="${pathData(s)}"/>`).join("");
    const cut = layer.cut ?? [];
    if (cut.length === 0) {
      body += paths;
      return;
    }
    defs +=
      `<mask id="c${i}"><rect x="-8" y="-8" width="80" height="80" fill="#fff"/>` +
      cut.map((s) => `<path d="${pathData(s)}" fill="#000"/>`).join("") +
      `</mask>`;
    body += `<g mask="url(#c${i})">${paths}</g>`;
  });
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="#fff">` +
    `<title>${title}</title>` +
    (defs === "" ? "" : `<defs>${defs}</defs>`) +
    body +
    `</svg>\n`
  );
}

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
write(
  path.join(ATLAS_DIR, "icon-atlas-ext.png"),
  encodePng(ICON_CELL * STRUCTURE_GLYPHS.length, ICON_CELL, buildIconAtlas()),
);
for (const [name, { title, icon }] of Object.entries(ICONS)) {
  write(path.join(IMAGE_DIR, `${name}IconWhite.svg`), toSvg(title, icon));
}
for (const s of UNIT_SPRITES) {
  console.log(`\n${s.type}\n${outlined(s.rows).join("\n")}`);
}
