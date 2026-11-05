import { GameMap } from "@openfront/engine-api/game/GameMap";
import { MapManifest } from "@openfront/engine-api/game/MapFiles";
import {
  GOLD_MINE_GOLD_PER_TICK,
  MAX_RESOURCE_SITES,
  MIN_RESOURCE_SITES,
  packResourceSites,
  placeResourceSites,
  RESOURCE_SITE_MIN_DISTANCE,
  resourceSiteCount,
  resourceSiteNear,
  ResourceSiteKind,
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

describe("resource site placement", () => {
  test("about one site per 60k land tiles, clamped to 6-24", () => {
    expect(resourceSiteCount(10_000)).toBe(MIN_RESOURCE_SITES);
    expect(resourceSiteCount(651_761)).toBe(11);
    expect(resourceSiteCount(2_317_767)).toBe(MAX_RESOURCE_SITES);
  });

  test("the world map gets its count on passable land, spaced out and away from nation spawns", async () => {
    const { map, spawns } = await loadMap("world");
    expect(spawns.length).toBeGreaterThan(0);
    const sites = placeResourceSites(map, new PseudoRandom(42), spawns);
    expect(sites).toHaveLength(resourceSiteCount(map.numLandTiles()));
    const min2 = RESOURCE_SITE_MIN_DISTANCE * RESOURCE_SITE_MIN_DISTANCE;
    for (const s of sites) {
      expect(s.kind).toBe(ResourceSiteKind.GoldMine);
      expect(map.isLand(s.tile)).toBe(true);
      expect(map.isImpassable(s.tile)).toBe(false);
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

  test("the same seed places the same sites, another seed others", async () => {
    const { map, spawns } = await loadMap("world");
    const a = placeResourceSites(map, new PseudoRandom(7), spawns);
    const b = placeResourceSites(map, new PseudoRandom(7), spawns);
    const c = placeResourceSites(map, new PseudoRandom(8), spawns);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test("a large map is capped and a tiny one gets what fits", async () => {
    const big = await loadMap("big_plains");
    expect(placeResourceSites(big.map, new PseudoRandom(1), [])).toHaveLength(
      MIN_RESOURCE_SITES,
    );
    const tiny = await loadMap("half_land_half_ocean");
    const sites = placeResourceSites(tiny.map, new PseudoRandom(1), []);
    expect(sites).toHaveLength(1);
    expect(tiny.map.isLand(sites[0].tile)).toBe(true);
  });

  test("a mine pays three quarters of a human's 100 gold base", () => {
    expect(GOLD_MINE_GOLD_PER_TICK).toBe(75n);
  });

  test("sites survive the wire format and are found near the cursor", async () => {
    const { map } = await loadMap("big_plains");
    const sites = placeResourceSites(map, new PseudoRandom(3), []);
    expect(unpackResourceSites(packResourceSites(sites))).toEqual(sites);
    const s = sites[0];
    const next = map.ref(map.x(s.tile) + 2, map.y(s.tile));
    expect(resourceSiteNear(map, sites, next, 3)).toEqual(s);
    expect(resourceSiteNear(map, sites, next, 1)).toBeNull();
  });
});
