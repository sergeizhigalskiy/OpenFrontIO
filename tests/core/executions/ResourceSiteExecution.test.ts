import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  mapHasOcean,
  RESOURCE_SITE_FIRST_PAY_TICKS,
  RESOURCE_SITE_INFO,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITES_RESEND_TICKS,
  ResourceSite,
  resourceSiteCount,
  resourceSiteHolderTile,
  ResourceSiteKind,
  unpackResourceSites,
} from "@openfront/engine-lib/game/ResourceSites";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import {
  MINE_TARGET_MAX_SITES,
  mineWeightedTroops,
} from "@openfront/engine/execution/nation/NationResourceSiteTargeting";
import {
  ResourceSiteExecution,
  ResourceSiteExecutionSnapshot,
  resourceSitesOf,
} from "@openfront/engine/execution/ResourceSiteExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { humanAndNationCount } from "@openfront/engine/game/StartPlacements";
import {
  createScriptedRunner,
  scriptedGameStart,
} from "../../util/ScriptedGame";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

let game: Game;
let alice: Player;
let bob: Player;

/**
 * A game of `humans` humans (alice, bob, then p2, p3...) with resource sites,
 * its spawn phase already over and the sites placed. "plains" and
 * "big_plains" are all land (mines and oil fields only); "world" has every
 * kind. Eight players get every kind the map has (fewer get no oil).
 */
async function start(
  config: Partial<GameConfig> = {},
  map: "plains" | "big_plains" | "world" = "plains",
  humans = 8,
): Promise<void> {
  const infos = [
    new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
    new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
  ];
  for (let i = 2; i < humans; i++) {
    infos.push(new PlayerInfo(`p${i}`, PlayerType.Human, `c${i}`, `p${i}`));
  }
  game = await setup(map, config, infos);
  alice = game.player("alice");
  bob = game.player("bob");
  game.addExecution(new ResourceSiteExecution("SITES001"));
  // The spawn phase ended before the first tick; the sites go down on the
  // second, once every spawn has landed.
  executeTicks(game, 2);
  expect(resourceSitesOf(game).length).toBeGreaterThan(0);
}

/** Runs to the first paying tick. */
function toFirstPay(): void {
  while (game.ticksSinceStart() < RESOURCE_SITE_FIRST_PAY_TICKS) {
    game.executeNextTick();
  }
}

/** Gold `player` gains over one tick (no PlayerExecution runs here). */
function goldOverOneTick(player: Player): bigint {
  const before = player.gold();
  game.executeNextTick();
  return player.gold() - before;
}

function sitesOfKind(kind: ResourceSiteKind): ResourceSite[] {
  return resourceSitesOf(game).filter((s) => s.kind === kind);
}

/** The tile whose owner a site pays right now. */
function holderTile(site: ResourceSite): number {
  const tile = resourceSiteHolderTile(game.map(), site);
  if (tile === null) throw new Error("site has no holder tile");
  return tile;
}

function dist(a: number, x: number, y: number): number {
  return Math.hypot(game.x(a) - x, game.y(a) - y);
}

describe("placing the sites", () => {
  test("nothing during the spawn phase; the players' count once the spawns have landed", async () => {
    game = await setup(
      "plains",
      {},
      [
        new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
      undefined,
      undefined,
      false,
    );
    game.addExecution(new ResourceSiteExecution("SITES001"));
    let announced = 0;
    for (let i = 0; i < 30; i++) {
      announced += game.executeNextTick()[GameUpdateType.ResourceSites].length;
    }
    // Not placed and not sent, so nobody sees them while picking a spawn.
    expect(game.inSpawnPhase()).toBe(true);
    expect(resourceSitesOf(game)).toEqual([]);
    expect(announced).toBe(0);

    game.endSpawnPhase();
    // A spawn picked on the phase's last tick lands this tick.
    game.executeNextTick();
    expect(resourceSitesOf(game)).toEqual([]);
    const placed = game.executeNextTick()[GameUpdateType.ResourceSites];
    expect(placed).toHaveLength(1);
    expect(unpackResourceSites(placed[0].sites)).toEqual(resourceSitesOf(game));
    // Two humans on a map with no ocean: a duel gets 1 mine and nothing else.
    expect(sitesOfKind(ResourceSiteKind.GoldMine)).toHaveLength(1);
    expect(sitesOfKind(ResourceSiteKind.OilField)).toEqual([]);
    expect(sitesOfKind(ResourceSiteKind.FishingGrounds)).toEqual([]);
    for (const s of resourceSitesOf(game)) {
      expect(game.isLand(s.tile)).toBe(true);
    }
  });

  test("a duel on a map with ocean gets one mine and nothing else", async () => {
    await start({}, "world", 2);
    expect(resourceSitesOf(game).map((s) => s.kind)).toEqual([
      ResourceSiteKind.GoldMine,
    ]);
  });

  test("the count follows the humans and nations, not the map", async () => {
    await start({}, "big_plains", 16);
    expect(humanAndNationCount(game)).toBe(16);
    // 16 / 4 = 4 mines plus one for no ocean; 16 / 12 rounds to 1 oil field.
    expect(sitesOfKind(ResourceSiteKind.GoldMine)).toHaveLength(5);
    expect(sitesOfKind(ResourceSiteKind.OilField)).toHaveLength(1);
    // Tribes don't count.
    game.addPlayer(new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"));
    expect(humanAndNationCount(game)).toBe(16);
  });

  test("40 tiles from every human spawn and every nation spawn", async () => {
    const cells = [new Cell(300, 300), new Cell(900, 400), new Cell(1500, 250)];
    const nations = cells.map(
      (c, i) =>
        new Nation(
          c,
          new PlayerInfo(`n${i}`, PlayerType.Nation, null, `n${i}`),
        ),
    );
    game = await setup(
      "world",
      {},
      [
        new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
        new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
      ],
      undefined,
      undefined,
      true,
      nations,
    );
    alice = game.player("alice");
    bob = game.player("bob");
    // Two humans and one nation have spawned; the other nations wait on
    // their cells.
    const spawned = [game.ref(1000, 300), game.ref(1100, 330)];
    alice.setSpawnTile(spawned[0]);
    bob.setSpawnTile(spawned[1]);
    const n0 = game.player("n0");
    const n0Spawn = game.ref(320, 310);
    n0.setSpawnTile(n0Spawn);
    expect(n0.hasSpawned()).toBe(true);
    game.addExecution(new ResourceSiteExecution("SITES001"));
    executeTicks(game, 2);

    const sites = resourceSitesOf(game);
    expect(sites.length).toBeGreaterThan(0);
    const spawns = [
      ...spawned.map((t) => ({ x: game.x(t), y: game.y(t) })),
      { x: game.x(n0Spawn), y: game.y(n0Spawn) },
      cells[1],
      cells[2],
    ];
    for (const s of sites) {
      for (const c of spawns) {
        expect(dist(s.tile, c.x, c.y)).toBeGreaterThanOrEqual(40);
      }
    }
  });
});

describe("paying the holders", () => {
  test("pays nothing until 60 s after the spawn phase", async () => {
    await start();
    expect(RESOURCE_SITE_FIRST_PAY_TICKS).toBe(600);
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    while (game.ticksSinceStart() < RESOURCE_SITE_FIRST_PAY_TICKS - 1) {
      expect(goldOverOneTick(alice)).toBe(0n);
    }
    expect(game.ticksSinceStart()).toBe(599);
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(alice)).toBe(30n);
  });

  test("a mine pays its tile's owner 30 gold per tick, and is captured with it", async () => {
    await start();
    toFirstPay();
    const [mine, second] = sitesOfKind(ResourceSiteKind.GoldMine);
    expect(goldOverOneTick(alice)).toBe(0n);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(30n);
    alice.conquer(second.tile);
    expect(goldOverOneTick(alice)).toBe(60n);
    bob.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(30n);
    expect(goldOverOneTick(bob)).toBe(30n);
  });

  test("an unowned or flooded mine pays no one", async () => {
    await start();
    toFirstPay();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    alice.relinquish(mine.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
    game.queueWaterConversion(mine.tile, true);
    game.executeNextTick();
    expect(game.isWater(mine.tile)).toBe(true);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("a mine the rising tide floods stops paying", async () => {
    await start();
    toFirstPay();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(30n);
    // A tide wave: the land is let go, then turned to water with the graph
    // rebuilt in the same tick (RisingTideExecution.flood).
    alice.relinquish(mine.tile);
    game.queueWaterConversion(mine.tile, true, true);
    game.executeNextTick();
    expect(game.isWater(mine.tile)).toBe(true);
    expect(goldOverOneTick(alice)).toBe(0n);
    // Still a site, so the view keeps drawing it where it was.
    expect(resourceSitesOf(game).map((s) => s.tile)).toContain(mine.tile);
  });

  test("scales with the gold multiplier like passive income", async () => {
    await start({ goldMultiplier: 2 });
    toFirstPay();
    const [mine] = sitesOfKind(ResourceSiteKind.GoldMine);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(60n);
  });

  test("an oil field pays its tile's owner 45 gold per tick, 90 at double gold", async () => {
    await start();
    toFirstPay();
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    expect(RESOURCE_SITE_INFO[oil.kind].goldPerTick).toBe(45n);
    alice.conquer(oil.tile);
    expect(goldOverOneTick(alice)).toBe(45n);
    bob.conquer(oil.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(bob)).toBe(45n);

    await start({ goldMultiplier: 2 });
    toFirstPay();
    const [doubled] = sitesOfKind(ResourceSiteKind.OilField);
    alice.conquer(doubled.tile);
    expect(goldOverOneTick(alice)).toBe(90n);
  });

  test("fishing grounds pay whoever holds the nearest coast 30 gold per tick, 60 at double gold", async () => {
    await start({}, "world");
    toFirstPay();
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    expect(game.isWater(fishing.tile)).toBe(true);
    // Its own water tile pays no one.
    expect(goldOverOneTick(alice)).toBe(0n);
    alice.conquer(holderTile(fishing));
    expect(goldOverOneTick(alice)).toBe(30n);
    bob.conquer(holderTile(fishing));
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(bob)).toBe(30n);

    await start({ goldMultiplier: 2 }, "world");
    toFirstPay();
    const [doubled] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    alice.conquer(holderTile(doubled));
    expect(goldOverOneTick(alice)).toBe(60n);
  });

  test("fishing grounds follow the coast when their coast tile is flooded", async () => {
    await start({}, "world");
    toFirstPay();
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    const coast = holderTile(fishing);
    alice.conquer(coast);
    expect(goldOverOneTick(alice)).toBe(30n);
    // Unowned, it pays no one.
    alice.relinquish(coast);
    expect(goldOverOneTick(alice)).toBe(0n);
    game.queueWaterConversion(coast, true);
    game.executeNextTick();
    expect(game.isWater(coast)).toBe(true);
    const next = holderTile(fishing);
    expect(next).not.toBe(coast);
    bob.conquer(next);
    expect(goldOverOneTick(bob)).toBe(30n);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("a holder is paid for their best 3 sites; the rest still deny others", async () => {
    await start({}, "big_plains", 16);
    toFirstPay();
    const mines = sitesOfKind(ResourceSiteKind.GoldMine);
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    expect(mines).toHaveLength(5);
    for (const m of mines.slice(0, 4)) alice.conquer(m.tile);
    // Four mines pay as three.
    expect(goldOverOneTick(alice)).toBe(90n);
    alice.conquer(oil.tile);
    // The oil field and two mines.
    expect(goldOverOneTick(alice)).toBe(105n);
    bob.conquer(mines[4].tile);
    expect(goldOverOneTick(bob)).toBe(30n);
    expect(goldOverOneTick(alice)).toBe(105n);
  });

  test("tribes and city-states are never paid", async () => {
    await start();
    toFirstPay();
    const [mine, second] = sitesOfKind(ResourceSiteKind.GoldMine);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    const cityState = game.addPlayer(
      new PlayerInfo("Aldmere", PlayerType.Bot, null, "cs"),
    );
    cityState.markCityState();
    tribe.conquer(mine.tile);
    cityState.conquer(second.tile);
    expect(goldOverOneTick(tribe)).toBe(0n);
    expect(goldOverOneTick(cityState)).toBe(0n);
    // Whoever takes the tile from the tribe is paid.
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(30n);
  });

  test("nations are paid like humans", async () => {
    await start();
    toFirstPay();
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    nation.conquer(oil.tile);
    expect(goldOverOneTick(nation)).toBe(45n);
  });
});

describe("the view and snapshots", () => {
  test("tells the view where the sites are once placed, and again every second", async () => {
    await start();
    let resent = 0;
    for (let i = 0; i < RESOURCE_SITES_RESEND_TICKS * 3; i++) {
      const sent = game.executeNextTick()[GameUpdateType.ResourceSites];
      resent += sent.length;
      for (const u of sent) {
        expect(unpackResourceSites(u.sites)).toEqual(resourceSitesOf(game));
      }
    }
    expect(resent).toBe(3);
  });

  test("snapshots and restores before the sites are placed", async () => {
    game = await setup(
      "plains",
      {},
      [new PlayerInfo("alice", PlayerType.Human, "client_a", "alice")],
      undefined,
      undefined,
      false,
    );
    game.addExecution(new ResourceSiteExecution("SITES001"));
    executeTicks(game, 3);
    const restored = await expectSnapshotRoundTrip(game, "plains", 3);
    expect(resourceSitesOf(restored)).toEqual([]);
  });

  test("snapshots and restores every kind, held and paying", async () => {
    await start({}, "world");
    toFirstPay();
    const [mine] = sitesOfKind(ResourceSiteKind.GoldMine);
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    alice.conquer(mine.tile);
    bob.conquer(oil.tile);
    alice.conquer(holderTile(fishing));
    executeTicks(game, 5);
    const restored = await expectSnapshotRoundTrip(game, "world", 10);
    const sites = resourceSitesOf(restored);
    expect(sites).toEqual(resourceSitesOf(game));
    expect(new Set(sites.map((s) => s.kind))).toEqual(
      new Set(RESOURCE_SITE_KINDS),
    );
    // Both games paid the same, mine plus fishing grounds to alice.
    const before = restored.player("alice").gold();
    restored.executeNextTick();
    expect(restored.player("alice").gold() - before).toBe(60n);
  });

  test("an older record, placed at game start, loads as placed", () => {
    const d = {
      active: true,
      initialized: true,
      gameID: "SITES001",
      sites: [{ tile: 5, kind: 0 }],
    };
    expect(readVersioned(ResourceSiteExecutionSnapshot, { v: 1, d })).toEqual({
      ...d,
      placed: true,
    });
    const fresh = { ...d, initialized: false, sites: [] };
    expect(
      readVersioned(ResourceSiteExecutionSnapshot, { v: 1, d: fresh }),
    ).toEqual({ ...fresh, placed: false });
  });
});

describe("the resource sites setting", () => {
  test("on: the game places every kind for its players once the spawn phase ends", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ resourceSites: true }),
    );
    const g = runner.game;
    executeTicks(g, 5);
    expect(g.inSpawnPhase()).toBe(true);
    expect(resourceSitesOf(g)).toEqual([]);
    g.endSpawnPhase();
    executeTicks(g, 2);
    const sites = resourceSitesOf(g);
    const players = humanAndNationCount(g);
    expect(g.nations().length).toBeGreaterThan(0);
    expect(players).toBeGreaterThan(g.nations().length);
    for (const kind of RESOURCE_SITE_KINDS) {
      expect(sites.filter((s) => s.kind === kind).length).toBe(
        resourceSiteCount(players, kind, mapHasOcean(g.map())),
      );
    }
    let nationSpawns = 0;
    for (const p of g.allPlayers()) {
      const spawn = p.spawnTile();
      if (p.type() !== PlayerType.Nation || spawn === undefined) continue;
      nationSpawns++;
      for (const s of sites) {
        expect(
          Math.sqrt(g.euclideanDistSquared(s.tile, spawn)),
        ).toBeGreaterThanOrEqual(40);
      }
    }
    expect(nationSpawns).toBeGreaterThan(0);
  });

  test("off: no sites", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ resourceSites: false }),
    );
    runner.game.endSpawnPhase();
    executeTicks(runner.game, 2);
    expect(resourceSitesOf(runner.game)).toEqual([]);
    expect(
      runner.game.executions().some((e) => e instanceof ResourceSiteExecution),
    ).toBe(false);
  });
});

describe("nations value targets holding mines", () => {
  test("a target holding mines ranks as weaker, more so on harder difficulties", async () => {
    const weighted = async (difficulty: Difficulty, mines: number) => {
      await start({ difficulty }, "big_plains", 24);
      bob.setTroops(10_000);
      for (const s of resourceSitesOf(game).slice(0, mines)) {
        bob.conquer(s.tile);
      }
      return mineWeightedTroops(game, bob);
    };
    expect(await weighted(Difficulty.Hard, 0)).toBe(10_000);
    expect(await weighted(Difficulty.Easy, 2)).toBe(10_000);
    expect(await weighted(Difficulty.Medium, 2)).toBe(9_000);
    expect(await weighted(Difficulty.Hard, 2)).toBe(8_000);
    expect(await weighted(Difficulty.Impossible, 2)).toBe(7_000);
    // Capped.
    expect(await weighted(Difficulty.Hard, 6)).toBe(
      10_000 * (1 - MINE_TARGET_MAX_SITES / 10),
    );
  });

  test("fishing grounds count for whoever holds their coast", async () => {
    await start({ difficulty: Difficulty.Hard }, "world");
    bob.setTroops(10_000);
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    expect(mineWeightedTroops(game, bob)).toBe(10_000);
    // The water tile itself can't be held; its coast can.
    bob.conquer(holderTile(fishing));
    expect(mineWeightedTroops(game, bob)).toBe(9_000);
    alice.conquer(holderTile(fishing));
    expect(mineWeightedTroops(game, bob)).toBe(10_000);
  });

  test("without sites the ranking is plain troops", async () => {
    game = await setup("plains", { difficulty: Difficulty.Impossible }, [
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ]);
    bob = game.player("bob");
    bob.setTroops(1234);
    expect(mineWeightedTroops(game, bob)).toBe(1234);
  });
});
