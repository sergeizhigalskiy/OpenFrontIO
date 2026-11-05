import { GameMap } from "@openfront/engine-api/game/GameMap";
import { MapManifest } from "@openfront/engine-api/game/MapFiles";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import {
  FISHING_GROUNDS_COAST_RADIUS,
  FISHING_GROUNDS_GOLD_PER_TICK,
  GOLD_MINE_GOLD_PER_TICK,
  MAX_RARE_SITES,
  MAX_RESOURCE_SITES,
  MIN_RARE_SITES,
  MIN_RESOURCE_SITES,
  OIL_FIELD_GOLD_PER_TICK,
  OIL_FIELD_SPAWN_DISTANCE,
  packResourceSites,
  placeResourceSites,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITE_MIN_DISTANCE,
  ResourceSite,
  resourceSiteCount,
  resourceSiteHolderID,
  resourceSiteHolderTile,
  ResourceSiteKind,
  resourceSiteNear,
  resourceSitePays,
  resourceSitesHeldBy,
  resourceSiteStands,
  unpackResourceSites,
} from "@openfront/engine-lib/game/ResourceSites";
import { genTerrainFromBin } from "@openfront/engine-lib/game/TerrainMapLoader";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadMap(
  name: string,
): Promise<{ map: GameMap; spawns: { x: number; y: number }[] }> {
  const dir = path.join(__dirname, `../../testdata/maps/${name}`);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
  ) as MapManifest;
  const map = await genTerrainFromBin(
    manifest.map,
    fs.readFileSync(path.join(dir, "map.bin")),
  );
  const spawns = (manifest.nations ?? [])
    .filter((n) => n.coordinates !== undefined)
    .map((n) => ({ x: n.coordinates![0], y: n.coordinates![1] }));
  return { map, spawns };
}

function dist2(map: GameMap, a: number, x: number, y: number): number {
  const dx = map.x(a) - x;
  const dy = map.y(a) - y;
  return dx * dx + dy * dy;
}

function ofKind(sites: ResourceSite[], kind: ResourceSiteKind): ResourceSite[] {
  return sites.filter((s) => s.kind === kind);
}

/** Squared distance from `tile` to the nearest passable land, brute force. */
function nearestLand2(map: GameMap, tile: number, radius: number): number {
  let best = Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = map.x(tile) + dx;
      const y = map.y(tile) + dy;
      if (!map.isValidCoord(x, y)) continue;
      const t = map.ref(x, y);
      if (!map.isLand(t) || map.isImpassable(t)) continue;
      best = Math.min(best, dx * dx + dy * dy);
    }
  }
  return best;
}

// Terrain bytes (see GameMapImpl): lake water is 0.
const OCEAN = 0x20;
const LAND = 0x80;
const IMPASSABLE = 0x80 | 31;

/** A `size`² ocean with land (or another terrain byte) at the given cells. */
function oceanMap(
  size: number,
  cells: [x: number, y: number, terrain?: number][],
): GameMapImpl {
  const terrain = new Uint8Array(size * size).fill(OCEAN);
  for (const [x, y, t] of cells) terrain[y * size + x] = t ?? LAND;
  const land = terrain.filter((t) => (t & LAND) !== 0).length;
  return new GameMapImpl(size, size, terrain, land);
}

/** Wire order of the kinds, pinned: it travels in updates and snapshots. */
const KINDS_ON_THE_WIRE = [
  ResourceSiteKind.GoldMine,
  ResourceSiteKind.OilField,
  ResourceSiteKind.FishingGrounds,
];

/**
 * The world map's gold mines for seed 42 and its nation spawns, as placed
 * before oil fields and fishing grounds existed.
 */
const WORLD_SEED_42_MINES = [
  1901633, 535523, 402448, 278266, 1993041, 368258, 513595, 613369, 201750,
  1371588, 1875768,
];

describe("resource site placement", () => {
  test("about one mine per 60k land tiles, clamped to 6-24", () => {
    expect(resourceSiteCount(10_000)).toBe(MIN_RESOURCE_SITES);
    expect(resourceSiteCount(651_761)).toBe(11);
    expect(resourceSiteCount(2_317_767)).toBe(MAX_RESOURCE_SITES);
  });

  test("about one oil field and one fishing ground per 180k land tiles, clamped to 2-8", () => {
    expect(MIN_RARE_SITES).toBe(2);
    expect(MAX_RARE_SITES).toBe(8);
    for (const kind of [
      ResourceSiteKind.OilField,
      ResourceSiteKind.FishingGrounds,
    ]) {
      expect(resourceSiteCount(10_000, kind)).toBe(2);
      expect(resourceSiteCount(540_000, kind)).toBe(3);
      expect(resourceSiteCount(651_761, kind)).toBe(4);
      expect(resourceSiteCount(2_317_767, kind)).toBe(8);
    }
  });

  test("kinds keep their wire order", () => {
    expect(RESOURCE_SITE_KINDS).toEqual(KINDS_ON_THE_WIRE);
  });

  test("gold mines land on the same tiles as before the new kinds", async () => {
    const { map, spawns } = await loadMap("world");
    const sites = placeResourceSites(map, new PseudoRandom(42), spawns);
    // Placed first, from the same draws.
    const first = sites.slice(0, WORLD_SEED_42_MINES.length);
    expect(first.every((s) => s.kind === ResourceSiteKind.GoldMine)).toBe(true);
    expect(first.map((s) => s.tile)).toEqual(WORLD_SEED_42_MINES);
    expect(ofKind(sites, ResourceSiteKind.GoldMine)).toHaveLength(
      WORLD_SEED_42_MINES.length,
    );
  });

  test("the world map gets every kind's count, spaced out and away from nation spawns", async () => {
    const { map, spawns } = await loadMap("world");
    expect(spawns.length).toBeGreaterThan(0);
    const sites = placeResourceSites(map, new PseudoRandom(42), spawns);
    for (const kind of RESOURCE_SITE_KINDS) {
      expect(ofKind(sites, kind)).toHaveLength(
        resourceSiteCount(map.numLandTiles(), kind),
      );
    }
    const min2 = RESOURCE_SITE_MIN_DISTANCE * RESOURCE_SITE_MIN_DISTANCE;
    for (const s of sites) {
      for (const c of spawns) {
        expect(dist2(map, s.tile, c.x, c.y)).toBeGreaterThanOrEqual(min2);
      }
      for (const o of sites) {
        if (o === s) continue;
        expect(
          dist2(map, s.tile, map.x(o.tile), map.y(o.tile)),
        ).toBeGreaterThanOrEqual(min2);
      }
    }
  });

  test("mines and oil fields sit on passable land, oil fields 50 tiles from every spawn", async () => {
    const { map, spawns } = await loadMap("world");
    expect(OIL_FIELD_SPAWN_DISTANCE).toBe(50);
    for (const seed of [42, 7, 8]) {
      const sites = placeResourceSites(map, new PseudoRandom(seed), spawns);
      const onLand = [
        ...ofKind(sites, ResourceSiteKind.GoldMine),
        ...ofKind(sites, ResourceSiteKind.OilField),
      ];
      for (const s of onLand) {
        expect(map.isLand(s.tile)).toBe(true);
        expect(map.isImpassable(s.tile)).toBe(false);
      }
      for (const s of ofKind(sites, ResourceSiteKind.OilField)) {
        for (const c of spawns) {
          expect(dist2(map, s.tile, c.x, c.y)).toBeGreaterThanOrEqual(50 * 50);
        }
      }
    }
  });

  test("fishing grounds sit on ocean 3 to 8 tiles off the nearest shore", async () => {
    const { map, spawns } = await loadMap("world");
    for (const seed of [42, 7, 8]) {
      const sites = placeResourceSites(map, new PseudoRandom(seed), spawns);
      const fishing = ofKind(sites, ResourceSiteKind.FishingGrounds);
      expect(fishing.length).toBeGreaterThan(0);
      for (const s of fishing) {
        expect(map.isWater(s.tile)).toBe(true);
        expect(map.isOcean(s.tile)).toBe(true);
        const d2 = nearestLand2(map, s.tile, 9);
        expect(d2).toBeGreaterThanOrEqual(3 * 3);
        expect(d2).toBeLessThanOrEqual(8 * 8);
        // Whoever takes that shore holds it from the start.
        expect(resourceSiteHolderTile(map, s)).not.toBeNull();
      }
    }
  });

  test("oil fields that can't keep 50 tiles from the spawns are left out, not placed closer", async () => {
    const { map } = await loadMap("plains");
    // Every tile of the 100x100 map is within 36 tiles of one of these.
    const crowded = [
      { x: 25, y: 25 },
      { x: 75, y: 25 },
      { x: 25, y: 75 },
      { x: 75, y: 75 },
    ];
    const sites = placeResourceSites(map, new PseudoRandom(1), crowded);
    expect(ofKind(sites, ResourceSiteKind.OilField)).toEqual([]);
    expect(ofKind(sites, ResourceSiteKind.GoldMine).length).toBeGreaterThan(0);
    // One spawn in the middle leaves only the corners.
    const middle = [{ x: 50, y: 50 }];
    for (const seed of [1, 2, 3]) {
      const oil = ofKind(
        placeResourceSites(map, new PseudoRandom(seed), middle),
        ResourceSiteKind.OilField,
      );
      expect(oil.length).toBeLessThanOrEqual(2);
      for (const s of oil) {
        expect(dist2(map, s.tile, 50, 50)).toBeGreaterThanOrEqual(50 * 50);
      }
    }
  });

  test("no ocean near a coast, no fishing grounds: lakes don't count", () => {
    const size = 200;
    const lakeCells: [number, number, number][] = [];
    const seaCells: [number, number, number][] = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const inWater = x >= 80 && x < 120 && y >= 80 && y < 120;
        lakeCells.push([x, y, inWater ? 0 : LAND]);
        seaCells.push([x, y, inWater ? OCEAN : LAND]);
      }
    }
    const lake = oceanMap(size, lakeCells);
    const lakeSites = placeResourceSites(lake, new PseudoRandom(1), []);
    expect(ofKind(lakeSites, ResourceSiteKind.FishingGrounds)).toEqual([]);
    expect(ofKind(lakeSites, ResourceSiteKind.GoldMine)).toHaveLength(6);

    const sea = oceanMap(size, seaCells);
    const seaSites = placeResourceSites(sea, new PseudoRandom(1), []);
    const fishing = ofKind(seaSites, ResourceSiteKind.FishingGrounds);
    expect(fishing.length).toBeGreaterThan(0);
    for (const s of fishing) {
      expect(sea.isOcean(s.tile)).toBe(true);
      const d2 = nearestLand2(sea, s.tile, 9);
      expect(d2).toBeGreaterThanOrEqual(9);
      expect(d2).toBeLessThanOrEqual(64);
    }
  });

  test("the same seed places the same sites, another seed others", async () => {
    const { map, spawns } = await loadMap("world");
    const a = placeResourceSites(map, new PseudoRandom(7), spawns);
    const b = placeResourceSites(map, new PseudoRandom(7), spawns);
    const c = placeResourceSites(map, new PseudoRandom(8), spawns);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const kind of RESOURCE_SITE_KINDS) {
      expect(ofKind(a, kind).length).toBeGreaterThan(0);
    }
  });

  test("a large map is capped and a tiny one gets what fits", async () => {
    const big = await loadMap("big_plains");
    const bigSites = placeResourceSites(big.map, new PseudoRandom(1), []);
    expect(ofKind(bigSites, ResourceSiteKind.GoldMine)).toHaveLength(
      MIN_RESOURCE_SITES,
    );
    expect(ofKind(bigSites, ResourceSiteKind.OilField)).toHaveLength(
      MIN_RARE_SITES,
    );
    // All land: nowhere to fish.
    expect(ofKind(bigSites, ResourceSiteKind.FishingGrounds)).toEqual([]);
    const tiny = await loadMap("half_land_half_ocean");
    const sites = placeResourceSites(tiny.map, new PseudoRandom(1), []);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe(ResourceSiteKind.GoldMine);
    expect(tiny.map.isLand(sites[0].tile)).toBe(true);
  });

  test("a mine pays three quarters of a human's 100 gold base, an oil field one and a half mines, fishing grounds a mine", () => {
    expect(GOLD_MINE_GOLD_PER_TICK).toBe(75n);
    expect(OIL_FIELD_GOLD_PER_TICK).toBe(112n);
    expect(FISHING_GROUNDS_GOLD_PER_TICK).toBe(75n);
  });

  test("sites survive the wire format and are found near the cursor", async () => {
    const { map } = await loadMap("big_plains");
    const sites = placeResourceSites(map, new PseudoRandom(3), []);
    expect(unpackResourceSites(packResourceSites(sites))).toEqual(sites);
    const every = KINDS_ON_THE_WIRE.map((kind, i) => ({ tile: i, kind }));
    expect(packResourceSites(every)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(unpackResourceSites(packResourceSites(every))).toEqual(every);
    // A kind from a newer engine is skipped.
    expect(unpackResourceSites([5, 0, 6, 99])).toEqual([
      { tile: 5, kind: ResourceSiteKind.GoldMine },
    ]);
    const s = sites[0];
    const next = map.ref(map.x(s.tile) + 2, map.y(s.tile));
    expect(resourceSiteNear(map, sites, next, 3)).toEqual(s);
    expect(resourceSiteNear(map, sites, next, 1)).toBeNull();
  });
});

describe("who holds a resource site", () => {
  // A fishing ground in the middle of a 31x31 ocean.
  const SIZE = 31;
  const C = 15;
  const fishingAt = (map: GameMap): ResourceSite => ({
    tile: map.ref(C, C),
    kind: ResourceSiteKind.FishingGrounds,
  });

  test("fishing grounds are held by the owner of the nearest coast", () => {
    const map = oceanMap(SIZE, [
      [C, C + 5],
      [C, C + 7],
      [C + 6, C],
    ]);
    const site = fishingAt(map);
    map.setOwnerID(map.ref(C, C + 5), 3);
    map.setOwnerID(map.ref(C + 6, C), 2);
    expect(resourceSiteHolderTile(map, site)).toBe(map.ref(C, C + 5));
    expect(resourceSiteHolderID(map, site)).toBe(3);
    expect(resourceSitePays(map, site)).toBe(true);
    expect(resourceSitesHeldBy(map, [site], 3)).toEqual([site]);
    expect(resourceSitesHeldBy(map, [site], 2)).toEqual([]);
    expect(resourceSiteStands(map, site)).toBe(true);
  });

  test("a tie goes to the lowest tile ref", () => {
    const sameRow = oceanMap(SIZE, [
      [C + 3, C],
      [C - 3, C],
    ]);
    expect(resourceSiteHolderTile(sameRow, fishingAt(sameRow))).toBe(
      sameRow.ref(C - 3, C),
    );
    const sameColumn = oceanMap(SIZE, [
      [C, C + 4],
      [C, C - 4],
    ]);
    expect(resourceSiteHolderTile(sameColumn, fishingAt(sameColumn))).toBe(
      sameColumn.ref(C, C - 4),
    );
    // Three tiles all 5 away: (3, 4), (4, 3) and (-4, 3) off the site.
    const diagonal = oceanMap(SIZE, [
      [C + 3, C + 4],
      [C + 4, C + 3],
      [C - 4, C + 3],
    ]);
    expect(resourceSiteHolderTile(diagonal, fishingAt(diagonal))).toBe(
      diagonal.ref(C - 4, C + 3),
    );
  });

  test("an unowned nearest coast pays no one, even with an owned one behind it", () => {
    const map = oceanMap(SIZE, [
      [C, C + 4],
      [C, C + 6],
    ]);
    const site = fishingAt(map);
    map.setOwnerID(map.ref(C, C + 6), 2);
    expect(resourceSiteHolderTile(map, site)).toBe(map.ref(C, C + 4));
    expect(resourceSiteHolderID(map, site)).toBe(0);
    expect(resourceSitePays(map, site)).toBe(false);
    expect(resourceSitesHeldBy(map, [site], 2)).toEqual([]);
    expect(resourceSitesHeldBy(map, [site], 0)).toEqual([]);
  });

  test("when the nearest coast turns to water the next nearest holds it", () => {
    const map = oceanMap(SIZE, [
      [C, C + 4],
      [C - 6, C],
    ]);
    const site = fishingAt(map);
    map.setOwnerID(map.ref(C, C + 4), 3);
    map.setOwnerID(map.ref(C - 6, C), 2);
    expect(resourceSiteHolderID(map, site)).toBe(3);
    map.setOwnerID(map.ref(C, C + 4), 0);
    map.setWater(map.ref(C, C + 4));
    expect(resourceSiteHolderTile(map, site)).toBe(map.ref(C - 6, C));
    expect(resourceSiteHolderID(map, site)).toBe(2);
  });

  test("no coast within 10 tiles pays no one", () => {
    expect(FISHING_GROUNDS_COAST_RADIUS).toBe(10);
    const far = oceanMap(SIZE, [[C, C + 11]]);
    far.setOwnerID(far.ref(C, C + 11), 2);
    expect(resourceSiteHolderTile(far, fishingAt(far))).toBeNull();
    expect(resourceSitePays(far, fishingAt(far))).toBe(false);
    // 6-8-10: exactly 10 away still counts.
    const edge = oceanMap(SIZE, [[C + 6, C + 8]]);
    expect(resourceSiteHolderTile(edge, fishingAt(edge))).toBe(
      edge.ref(C + 6, C + 8),
    );
  });

  test("impassable land and land walled in by it are not coast", () => {
    const map = oceanMap(SIZE, [
      // A passable tile 3 away with impassable land on all four sides.
      [C, C + 3],
      [C - 1, C + 3, IMPASSABLE],
      [C + 1, C + 3, IMPASSABLE],
      [C, C + 2, IMPASSABLE],
      [C, C + 4, IMPASSABLE],
      // Real coast, 5 away.
      [C + 5, C],
    ]);
    const site = fishingAt(map);
    map.setOwnerID(map.ref(C, C + 3), 2);
    map.setOwnerID(map.ref(C + 5, C), 3);
    expect(resourceSiteHolderTile(map, site)).toBe(map.ref(C + 5, C));
    expect(resourceSiteHolderID(map, site)).toBe(3);
  });

  test("a mine or oil field is held with its own tile until dug out", () => {
    const map = oceanMap(SIZE, [[3, 3]]);
    const tile = map.ref(3, 3);
    map.setOwnerID(tile, 4);
    for (const kind of [ResourceSiteKind.GoldMine, ResourceSiteKind.OilField]) {
      const site = { tile, kind };
      expect(resourceSiteStands(map, site)).toBe(true);
      expect(resourceSiteHolderTile(map, site)).toBe(tile);
      expect(resourceSiteHolderID(map, site)).toBe(4);
    }
    map.setOwnerID(tile, 0);
    map.setWater(tile);
    const mine = { tile, kind: ResourceSiteKind.GoldMine };
    expect(resourceSiteStands(map, mine)).toBe(false);
    expect(resourceSiteHolderTile(map, mine)).toBeNull();
    expect(resourceSitePays(map, mine)).toBe(false);
  });
});
