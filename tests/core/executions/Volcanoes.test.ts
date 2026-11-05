import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameMapSize,
  GameMapType,
  MessageType,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  DisplayMessageUpdate,
  GameUpdateType,
  VolcanoUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { MapManifestSchema } from "@openfront/engine-api/game/MapManifest";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import {
  selectVolcanoSites,
  tilesInRadius,
  troopsLostWithLand,
  VOLCANO_ERUPTION_RADIUS,
  VOLCANO_FALLOUT_TICKS,
  VOLCANO_FIRST_RUMBLE_TICKS,
  VOLCANO_MAX_INTERVAL_TICKS,
  VOLCANO_MIN_INTERVAL_TICKS,
  VOLCANO_MIN_SITE_SPACING,
  VOLCANO_WARNING_RADIUS,
  VOLCANO_WARNING_TICKS,
  volcanoSiteCount,
} from "@openfront/engine-lib/game/Volcanoes";
import {
  inVolcanoWarning,
  VolcanoExecution,
} from "@openfront/engine/execution/VolcanoExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import fs from "fs";
import path from "path";
import {
  createScriptedRunner,
  scriptedGameStart,
} from "../../util/ScriptedGame";
import { setup } from "../../util/Setup";

const LAND = 0x80;

/**
 * A 700x10 plain of magnitude 5 with a few raised tiles. `numLandTiles` only
 * sets how many sites the map asks for.
 */
function plainWith(
  peaks: { x: number; y: number; magnitude: number }[],
  numLandTiles = 2_000_000,
): GameMapImpl {
  const w = 700;
  const h = 10;
  const terrain = new Uint8Array(w * h).fill(LAND | 5);
  for (const p of peaks) terrain[p.y * w + p.x] = LAND | p.magnitude;
  return new GameMapImpl(w, h, terrain, numLandTiles);
}

describe("volcano site selection", () => {
  test("site count scales with land, 1 to 4", () => {
    expect(volcanoSiteCount(10_000)).toBe(1);
    expect(volcanoSiteCount(600_000)).toBe(1);
    expect(volcanoSiteCount(600_001)).toBe(2);
    expect(volcanoSiteCount(1_500_000)).toBe(3);
    expect(volcanoSiteCount(4_000_000)).toBe(4);
  });

  test("highest mountains first, 150 tiles apart, local high points only", () => {
    const map = plainWith([
      { x: 10, y: 5, magnitude: 30 },
      // Within 150 of the first site.
      { x: 155, y: 5, magnitude: 28 },
      // Far enough, but on the flank of the higher peak above.
      { x: 161, y: 5, magnitude: 26 },
      { x: 400, y: 5, magnitude: 25 },
      { x: 650, y: 5, magnitude: 22 },
    ]);
    const sites = selectVolcanoSites(map);
    expect(sites).toEqual([map.ref(10, 5), map.ref(400, 5), map.ref(650, 5)]);
    for (const a of sites) {
      expect(map.terrainType(a)).toBe(TerrainType.Mountain);
      for (const b of sites) {
        if (a === b) continue;
        expect(map.euclideanDistSquared(a, b)).toBeGreaterThanOrEqual(
          VOLCANO_MIN_SITE_SPACING ** 2,
        );
      }
    }
  });

  test("the map's hand-placed list replaces auto-placement", () => {
    const map = plainWith([{ x: 10, y: 5, magnitude: 30 }]);
    const sites = selectVolcanoSites(map, [
      { x: 3, y: 3 },
      { x: 3, y: 3 }, // repeat
      { x: 9999, y: 1 }, // off the map
      { x: 50, y: 2 },
      { x: 60, y: 2 },
      { x: 70, y: 2 },
      { x: 80, y: 2 }, // a fifth
    ]);
    expect(sites).toEqual([
      map.ref(3, 3),
      map.ref(50, 2),
      map.ref(60, 2),
      map.ref(70, 2),
    ]);
    // An empty list means auto-placement.
    expect(selectVolcanoSites(map, [])).toEqual([map.ref(10, 5)]);
  });

  test("deterministic on a real map, and without mountains uses the highest land", async () => {
    const world = await setup("world");
    const a = selectVolcanoSites(world.map());
    const b = selectVolcanoSites((await setup("world")).map());
    expect(a).toEqual(b);
    expect(a).toHaveLength(volcanoSiteCount(world.map().numLandTiles()));
    for (const s of a) {
      expect(world.map().terrainType(s)).toBe(TerrainType.Mountain);
    }
    expect(world.euclideanDistSquared(a[0], a[1])).toBeGreaterThanOrEqual(
      VOLCANO_MIN_SITE_SPACING ** 2,
    );

    // plains has no mountains: its one site is its highest tile.
    const plains = (await setup("plains")).map();
    const [site] = selectVolcanoSites(plains);
    let highest = 0;
    plains.forEachTile((t) => {
      if (plains.isLand(t)) highest = Math.max(highest, plains.magnitude(t));
    });
    expect(plains.magnitude(site)).toBe(highest);
  });
});

describe("troopsLostWithLand", () => {
  test("troops per tile times the tiles lost, floored", () => {
    expect(troopsLostWithLand(1000, 100, 10)).toBe(100);
    expect(troopsLostWithLand(999, 100, 10)).toBe(99);
    expect(troopsLostWithLand(1000, 100, 100)).toBe(1000);
    expect(troopsLostWithLand(1000, 0, 10)).toBe(0);
    expect(troopsLostWithLand(1000, 100, 0)).toBe(0);
  });
});

/** One tick, returning its updates. */
function step(game: Game) {
  return game.executeNextTick();
}

function runTo(game: Game, tick: number) {
  while (game.ticks() < tick) step(game);
}

function conquerDisc(
  game: Game,
  p: Player,
  cx: number,
  cy: number,
  r: number,
): TileRef[] {
  const tiles = tilesInRadius(game.map(), game.ref(cx, cy), r).filter(
    (t) => game.isLand(t) && !game.hasOwner(t),
  );
  for (const t of tiles) p.conquer(t);
  return tiles;
}

describe("VolcanoExecution", () => {
  const SITE = { x: 100, y: 100 };
  let game: Game;
  let near: Player;
  let ring: Player;
  let far: Player;
  let exec: VolcanoExecution;

  beforeEach(async () => {
    game = await setup("big_plains", {}, [
      new PlayerInfo("near", PlayerType.Human, "c_near", "near"),
      new PlayerInfo("ring", PlayerType.Human, "c_ring", "ring"),
      new PlayerInfo("far", PlayerType.Human, "c_far", "far"),
    ]);
    near = game.player("near");
    ring = game.player("ring");
    far = game.player("far");
    // near: a disc of 20 around the site, so some of it is outside the blast.
    conquerDisc(game, near, SITE.x, SITE.y, 20);
    // ring: only land between the blast and the warning radius.
    conquerDisc(game, ring, SITE.x, SITE.y, VOLCANO_WARNING_RADIUS);
    conquerDisc(game, far, 20, 20, 10);
    for (const p of [near, ring, far]) p.setTroops(100_000);
    exec = new VolcanoExecution("volcano-test", [SITE]);
    game.addExecution(exec);
  });

  test("starts at tick 0 and sends its sites", async () => {
    const g = await setup("big_plains", {}, [], undefined, undefined, false);
    g.addExecution(new VolcanoExecution("v", [SITE]));
    const updates = step(g)[GameUpdateType.Cataclysm] as VolcanoUpdate[];
    expect(g.inSpawnPhase()).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].sites).toEqual([g.ref(SITE.x, SITE.y)]);
    expect(updates[0].rumblingSite).toBeNull();
  });

  test("rumbles after 8 minutes, warns the players in the ring, erupts 20 s later", () => {
    const site = game.ref(SITE.x, SITE.y);
    runTo(game, VOLCANO_FIRST_RUMBLE_TICKS);
    expect(inVolcanoWarning(game, site)).toBe(false);

    const rumble = step(game);
    const update = (rumble[GameUpdateType.Cataclysm] as VolcanoUpdate[])[0];
    expect(update.rumblingSite).toBe(site);
    expect(update.eruptionTick).toBe(
      VOLCANO_FIRST_RUMBLE_TICKS + VOLCANO_WARNING_TICKS,
    );
    const warnings = (
      rumble[GameUpdateType.DisplayEvent] as DisplayMessageUpdate[]
    ).filter((m) => m.message === "events_display.volcano_rumbling");
    expect(warnings.map((m) => m.playerID).sort()).toEqual(
      [near.smallID(), ring.smallID()].sort(),
    );
    expect(warnings[0].messageType).toBe(MessageType.NUKE_INBOUND);
    expect(inVolcanoWarning(game, site)).toBe(true);
    expect(inVolcanoWarning(game, game.ref(20, 20))).toBe(false);

    // Nothing happens during the warning.
    const tilesDuring = near.numTilesOwned();
    runTo(game, update.eruptionTick);
    expect(near.numTilesOwned()).toBe(tilesDuring);
    const eruption = step(game);
    const erupted = (eruption[GameUpdateType.Cataclysm] as VolcanoUpdate[])[0];
    expect(erupted.eruptedSite).toBe(site);
    expect(erupted.rumblingSite).toBeNull();
    expect(near.numTilesOwned()).toBeLessThan(tilesDuring);
    expect(inVolcanoWarning(game, site)).toBe(false);
    const messages = (
      eruption[GameUpdateType.DisplayEvent] as DisplayMessageUpdate[]
    ).filter((m) => m.message === "events_display.volcano_erupted");
    expect(messages.map((m) => m.playerID)).toEqual([near.smallID()]);
    expect(messages[0].messageType).toBe(MessageType.NUKE_DETONATED);

    // The next rumble comes 8 to 12 minutes after the first.
    let next = -1;
    while (
      game.ticks() <=
      VOLCANO_FIRST_RUMBLE_TICKS + VOLCANO_MAX_INTERVAL_TICKS
    ) {
      step(game);
      if (inVolcanoWarning(game, site)) {
        next = game.ticks() - 1;
        break;
      }
    }
    expect(next - VOLCANO_FIRST_RUMBLE_TICKS).toBeGreaterThanOrEqual(
      VOLCANO_MIN_INTERVAL_TICKS,
    );
    expect(next - VOLCANO_FIRST_RUMBLE_TICKS).toBeLessThanOrEqual(
      VOLCANO_MAX_INTERVAL_TICKS,
    );
  });

  test("clears owners, structures and fallout in the radius only, then lifts the fallout", () => {
    const site = game.ref(SITE.x, SITE.y);
    const inside = game.ref(SITE.x + 10, SITE.y);
    const outside = game.ref(SITE.x + 17, SITE.y);
    const cityIn = near.buildUnit(UnitType.City, inside, {});
    const postIn = near.buildUnit(UnitType.DefensePost, site, {});
    const cityOut = near.buildUnit(UnitType.City, outside, {});
    const eruptionTick = VOLCANO_FIRST_RUMBLE_TICKS + VOLCANO_WARNING_TICKS;
    runTo(game, eruptionTick + 1);

    const blast = new Set(
      tilesInRadius(game.map(), site, VOLCANO_ERUPTION_RADIUS),
    );
    for (const t of blast) {
      expect(game.hasOwner(t)).toBe(false);
      expect(game.hasFallout(t)).toBe(true);
    }
    // Just outside the blast: still owned, no fallout.
    for (const t of tilesInRadius(
      game.map(),
      site,
      VOLCANO_ERUPTION_RADIUS + 2,
    )) {
      if (blast.has(t)) continue;
      expect(game.hasOwner(t)).toBe(true);
      expect(game.hasFallout(t)).toBe(false);
    }
    expect(cityIn.isActive()).toBe(false);
    expect(postIn.isActive()).toBe(false);
    expect(cityOut.isActive()).toBe(true);
    expect(game.numTilesWithFallout()).toBe(blast.size);

    runTo(game, eruptionTick + VOLCANO_FALLOUT_TICKS + 1);
    expect(game.numTilesWithFallout()).toBe(0);
  });

  test("each player loses troops per tile times the tiles lost", () => {
    const site = game.ref(SITE.x, SITE.y);
    const blast = tilesInRadius(game.map(), site, VOLCANO_ERUPTION_RADIUS);
    const nearLost = blast.filter((t) => game.owner(t) === near).length;
    const nearBefore = near.numTilesOwned();
    const ringLost = blast.filter((t) => game.owner(t) === ring).length;
    expect(nearLost).toBeGreaterThan(0);
    expect(ringLost).toBe(0);

    runTo(game, VOLCANO_FIRST_RUMBLE_TICKS + VOLCANO_WARNING_TICKS + 1);
    expect(near.numTilesOwned()).toBe(nearBefore - nearLost);
    expect(near.troops()).toBe(
      100_000 - Math.floor((100_000 * nearLost) / nearBefore),
    );
    expect(ring.troops()).toBe(100_000);
    expect(far.troops()).toBe(100_000);
  });
});

describe("volcanoes lobby setting", () => {
  test("off by default: no volcano execution runs", async () => {
    const off = await createScriptedRunner("world", scriptedGameStart());
    expect(off.game.config().volcanoes()).toBe(false);
    expect(
      off.game.executions().some((e) => e instanceof VolcanoExecution),
    ).toBe(false);

    const on = await createScriptedRunner(
      "world",
      scriptedGameStart({ volcanoes: true }),
    );
    expect(on.game.config().volcanoes()).toBe(true);
    expect(
      on.game.executions().some((e) => e instanceof VolcanoExecution),
    ).toBe(true);
  });
});

describe("hand-placed volcanoes in the map files", () => {
  const ROOT = path.resolve(__dirname, "../../..");
  const manifest = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "resources/maps/africa/manifest.json"),
        "utf8",
      ),
    );

  test("the manifest schema takes 1 to 4 sites on the map", () => {
    const ok = { ...manifest(), volcanoes: [{ x: 10, y: 20 }] };
    expect(MapManifestSchema.safeParse(ok).success).toBe(true);
    const { width } = ok.map;
    const off = { ...manifest(), volcanoes: [{ x: width, y: 0 }] };
    expect(MapManifestSchema.safeParse(off).success).toBe(false);
    const many = {
      ...manifest(),
      volcanoes: [1, 2, 3, 4, 5].map((x) => ({ x, y: 1 })),
    };
    expect(MapManifestSchema.safeParse(many).success).toBe(false);
    const empty = { ...manifest(), volcanoes: [] };
    expect(MapManifestSchema.safeParse(empty).success).toBe(false);
  });

  test("the loader passes them on, halved on compact maps", async () => {
    const dir = path.join(ROOT, "tests/testdata/maps/plains");
    const read = (f: string) =>
      new Uint8Array(fs.readFileSync(path.join(dir, f)));
    const base = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
    );
    const files = (mapSize: GameMapSize) => ({
      map: GameMapType.World,
      mapSize,
      manifest: { ...base, nations: [], volcanoes: [{ x: 41, y: 60 }] },
      mapBin: read("map.bin"),
      map4xBin: read("map4x.bin"),
      map16xBin: read("map16x.bin"),
    });
    const normal = await loadTerrainMap(files(GameMapSize.Normal));
    expect(normal.volcanoes).toEqual([{ x: 41, y: 60 }]);
    const compact = await loadTerrainMap(files(GameMapSize.Compact));
    expect(compact.volcanoes).toEqual([{ x: 20, y: 30 }]);
  });
});
