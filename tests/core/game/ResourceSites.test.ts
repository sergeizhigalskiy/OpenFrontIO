import { GameMap } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { MapManifest } from "@openfront/engine-api/game/MapFiles";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import {
  FISHING_GROUNDS_COAST_RADIUS,
  FISHING_GROUNDS_GOLD_PER_TICK,
  GOLD_MINE_GOLD_PER_TICK,
  mapHasOcean,
  OIL_FIELD_GOLD_PER_TICK,
  packResourceSites,
  paidByResourceSites,
  placeResourceSites,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITE_MIN_DISTANCE,
  RESOURCE_SITE_SPAWN_DISTANCE,
  RESOURCE_SITES_PAID_PER_PLAYER,
  ResourceSite,
  resourceSiteCount,
  resourceSiteHolderID,
  resourceSiteHolderTile,
  ResourceSiteKind,
  resourceSiteNear,
  resourceSitePays,
  resourceSitesGoldPerTick,
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

/** [players, mines, oil fields, fishing grounds] with ocean. */
const COUNTS_WITH_OCEAN: [number, number, number, number][] = [
  [0, 2, 1, 1],
  // A duel.
  [2, 2, 1, 1],
  // Iceland: 8 nations and a human.
  [9, 2, 1, 1],
  [20, 5, 2, 2],
  [40, 10, 3, 3],
  // World: 72 nations and a human.
  [73, 10, 3, 3],
];

describe("how many resource sites", () => {
  test.each(COUNTS_WITH_OCEAN)(
    "%i players, with ocean: %i mines, %i oil fields, %i fishing grounds",
    (players, mines, oil, fishing) => {
      expect(resourceSiteCount(players, ResourceSiteKind.GoldMine, true)).toBe(
        mines,
      );
      expect(resourceSiteCount(players, ResourceSiteKind.OilField, true)).toBe(
        oil,
      );
      expect(
        resourceSiteCount(players, ResourceSiteKind.FishingGrounds, true),
      ).toBe(fishing);
    },
  );

  test("without ocean there is no fishing and one more mine", () => {
    for (const [players, mines, oil] of COUNTS_WITH_OCEAN) {
      expect(resourceSiteCount(players, ResourceSiteKind.GoldMine, false)).toBe(
        mines + 1,
      );
      expect(resourceSiteCount(players, ResourceSiteKind.OilField, false)).toBe(
        oil,
      );
      expect(
        resourceSiteCount(players, ResourceSiteKind.FishingGrounds, false),
      ).toBe(0);
    }
  });

  test("lakes are not ocean", async () => {
    expect(mapHasOcean((await loadMap("world")).map)).toBe(true);
    expect(mapHasOcean((await loadMap("plains")).map)).toBe(false);
    const lake = new GameMapImpl(2, 1, new Uint8Array([LAND, 0]), 1);
    expect(mapHasOcean(lake)).toBe(false);
  });
});

describe("resource site pay", () => {
  test("a mine pays 30 gold a tick, an oil field 45, fishing grounds 30", () => {
    expect(GOLD_MINE_GOLD_PER_TICK).toBe(30n);
    expect(OIL_FIELD_GOLD_PER_TICK).toBe(45n);
    expect(FISHING_GROUNDS_GOLD_PER_TICK).toBe(30n);
  });

  test("a holder is paid for their best 3 sites at most", () => {
    expect(RESOURCE_SITES_PAID_PER_PLAYER).toBe(3);
    const site = (kind: ResourceSiteKind, tile: number): ResourceSite => ({
      tile,
      kind,
    });
    const mine = (t: number) => site(ResourceSiteKind.GoldMine, t);
    const oil = (t: number) => site(ResourceSiteKind.OilField, t);
    const fishing = (t: number) => site(ResourceSiteKind.FishingGrounds, t);
    expect(resourceSitesGoldPerTick([])).toBe(0n);
    expect(resourceSitesGoldPerTick([mine(1)])).toBe(30n);
    expect(resourceSitesGoldPerTick([mine(1), oil(2), fishing(3)])).toBe(105n);
    // Four mines pay as three.
    expect(resourceSitesGoldPerTick([mine(1), mine(2), mine(3), mine(4)])).toBe(
      90n,
    );
    // The best three, whatever the order: two oil fields and a mine.
    expect(
      resourceSitesGoldPerTick([mine(1), fishing(2), oil(3), mine(4), oil(5)]),
    ).toBe(120n);
  });

  test("only humans and nations are paid, never tribes or city-states", () => {
    expect(paidByResourceSites(PlayerType.Human)).toBe(true);
    expect(paidByResourceSites(PlayerType.Nation)).toBe(true);
    expect(paidByResourceSites(PlayerType.Bot)).toBe(false);
  });
});

describe("resource site placement", () => {
  test("kinds keep their wire order", () => {
    expect(RESOURCE_SITE_KINDS).toEqual(KINDS_ON_THE_WIRE);
  });

  test("the world map gets its players' count of every kind, 25 apart and 40 from every spawn", async () => {
    const { map, spawns } = await loadMap("world");
    expect(spawns.length).toBeGreaterThan(0);
    expect(RESOURCE_SITE_SPAWN_DISTANCE).toBe(40);
    expect(RESOURCE_SITE_MIN_DISTANCE).toBe(25);
    // The nations and a human.
    const players = spawns.length + 1;
    for (const seed of [42, 7, 8]) {
      const sites = placeResourceSites(
        map,
        new PseudoRandom(seed),
        players,
        spawns,
      );
      for (const kind of RESOURCE_SITE_KINDS) {
        expect(ofKind(sites, kind)).toHaveLength(
          resourceSiteCount(players, kind, true),
        );
      }
      for (const s of sites) {
        for (const c of spawns) {
          expect(dist2(map, s.tile, c.x, c.y)).toBeGreaterThanOrEqual(40 * 40);
        }
        for (const o of sites) {
          if (o === s) continue;
          expect(
            dist2(map, s.tile, map.x(o.tile), map.y(o.tile)),
          ).toBeGreaterThanOrEqual(25 * 25);
        }
      }
    }
  });

  test("mines and oil fields sit on passable land", async () => {
    const { map, spawns } = await loadMap("world");
    for (const seed of [42, 7, 8]) {
      const sites = placeResourceSites(map, new PseudoRandom(seed), 62, spawns);
      const onLand = [
        ...ofKind(sites, ResourceSiteKind.GoldMine),
        ...ofKind(sites, ResourceSiteKind.OilField),
      ];
      expect(onLand.length).toBeGreaterThan(0);
      for (const s of onLand) {
        expect(map.isLand(s.tile)).toBe(true);
        expect(map.isImpassable(s.tile)).toBe(false);
      }
    }
  });

  test("fishing grounds sit on ocean 3 to 8 tiles off the nearest shore", async () => {
    const { map, spawns } = await loadMap("world");
    for (const seed of [42, 7, 8]) {
      const sites = placeResourceSites(map, new PseudoRandom(seed), 62, spawns);
      const fishing = ofKind(sites, ResourceSiteKind.FishingGrounds);
      expect(fishing.length).toBeGreaterThan(0);
      for (const s of fishing) {
        expect(map.isWater(s.tile)).toBe(true);
        expect(map.isOcean(s.tile)).toBe(true);
        const d2 = nearestLand2(map, s.tile, 9);
        expect(d2).toBeGreaterThanOrEqual(3 * 3);
        expect(d2).toBeLessThanOrEqual(8 * 8);
        // Whoever takes that shore holds it.
        expect(resourceSiteHolderTile(map, s)).not.toBeNull();
      }
    }
  });

  test("sites that can't keep 40 tiles from the spawns are left out, not placed closer", async () => {
    const { map } = await loadMap("plains");
    // Every tile of the 100x100 map is within 36 tiles of one of these.
    const crowded = [
      { x: 25, y: 25 },
      { x: 75, y: 25 },
      { x: 25, y: 75 },
      { x: 75, y: 75 },
    ];
    expect(placeResourceSites(map, new PseudoRandom(1), 4, crowded)).toEqual(
      [],
    );
    // One spawn in the middle leaves only the corners.
    const middle = [{ x: 50, y: 50 }];
    for (const seed of [1, 2, 3]) {
      const sites = placeResourceSites(map, new PseudoRandom(seed), 4, middle);
      expect(sites.length).toBeGreaterThan(0);
      for (const s of sites) {
        expect(dist2(map, s.tile, 50, 50)).toBeGreaterThanOrEqual(40 * 40);
      }
    }
  });

  test("no ocean near a coast, no fishing grounds and one more mine: lakes don't count", () => {
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
    const lakeSites = placeResourceSites(lake, new PseudoRandom(1), 8, []);
    expect(ofKind(lakeSites, ResourceSiteKind.FishingGrounds)).toEqual([]);
    expect(ofKind(lakeSites, ResourceSiteKind.GoldMine)).toHaveLength(3);
    expect(ofKind(lakeSites, ResourceSiteKind.OilField)).toHaveLength(1);

    const sea = oceanMap(size, seaCells);
    const seaSites = placeResourceSites(sea, new PseudoRandom(1), 8, []);
    expect(ofKind(seaSites, ResourceSiteKind.GoldMine)).toHaveLength(2);
    const fishing = ofKind(seaSites, ResourceSiteKind.FishingGrounds);
    expect(fishing).toHaveLength(1);
    for (const s of fishing) {
      expect(sea.isOcean(s.tile)).toBe(true);
      const d2 = nearestLand2(sea, s.tile, 9);
      expect(d2).toBeGreaterThanOrEqual(9);
      expect(d2).toBeLessThanOrEqual(64);
    }
  });

  test("the same seed places the same sites, another seed others", async () => {
    const { map, spawns } = await loadMap("world");
    const a = placeResourceSites(map, new PseudoRandom(7), 62, spawns);
    const b = placeResourceSites(map, new PseudoRandom(7), 62, spawns);
    const c = placeResourceSites(map, new PseudoRandom(8), 62, spawns);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    for (const kind of RESOURCE_SITE_KINDS) {
      expect(ofKind(a, kind).length).toBeGreaterThan(0);
    }
  });

  test("the map's size doesn't change the count, and a tiny map gets what fits", async () => {
    const small = await loadMap("plains");
    const big = await loadMap("big_plains");
    for (const { map } of [small, big]) {
      const sites = placeResourceSites(map, new PseudoRandom(1), 9, []);
      // All land: one more mine, nowhere to fish.
      expect(ofKind(sites, ResourceSiteKind.GoldMine)).toHaveLength(3);
      expect(ofKind(sites, ResourceSiteKind.OilField)).toHaveLength(1);
      expect(ofKind(sites, ResourceSiteKind.FishingGrounds)).toEqual([]);
    }
    const tiny = await loadMap("half_land_half_ocean");
    const sites = placeResourceSites(tiny.map, new PseudoRandom(1), 9, []);
    expect(sites).toHaveLength(1);
    expect(sites[0].kind).toBe(ResourceSiteKind.GoldMine);
    expect(tiny.map.isLand(sites[0].tile)).toBe(true);
  });

  test("sites survive the wire format and are found near the cursor", async () => {
    const { map } = await loadMap("big_plains");
    const sites = placeResourceSites(map, new PseudoRandom(3), 9, []);
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
