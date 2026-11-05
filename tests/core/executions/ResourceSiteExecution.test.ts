import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  RESOURCE_SITE_INFO,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITES_RESEND_TICKS,
  ResourceSite,
  resourceSiteCount,
  resourceSiteHolderTile,
  ResourceSiteKind,
  unpackResourceSites,
} from "@openfront/engine-lib/game/ResourceSites";
import {
  MINE_TARGET_MAX_SITES,
  mineWeightedTroops,
} from "@openfront/engine/execution/nation/NationResourceSiteTargeting";
import {
  ResourceSiteExecution,
  resourceSitesOf,
} from "@openfront/engine/execution/ResourceSiteExecution";
import { Game, Player } from "@openfront/engine/game/Game";
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
 * A two-player game with resource sites. "plains" is all land (mines and
 * oil fields only); "world" has every kind.
 */
async function start(
  config: Partial<GameConfig> = {},
  autoEndSpawnPhase = true,
  map: "plains" | "world" = "plains",
): Promise<void> {
  game = await setup(
    map,
    config,
    [
      new PlayerInfo("alice", PlayerType.Human, "client_a", "alice"),
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ],
    undefined,
    undefined,
    autoEndSpawnPhase,
  );
  alice = game.player("alice");
  bob = game.player("bob");
  game.addExecution(new ResourceSiteExecution("SITES001"));
  game.executeNextTick();
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

describe("ResourceSiteExecution", () => {
  test("places the sites when it starts", async () => {
    await start();
    const sites = resourceSitesOf(game);
    expect(sitesOfKind(ResourceSiteKind.GoldMine)).toHaveLength(6);
    expect(sitesOfKind(ResourceSiteKind.OilField)).toHaveLength(2);
    // All land: no fishing.
    expect(sitesOfKind(ResourceSiteKind.FishingGrounds)).toEqual([]);
    for (const s of sites) expect(game.isLand(s.tile)).toBe(true);
  });

  test("pays the owner of a mine's tile 75 gold per tick", async () => {
    await start();
    const [mine, second] = resourceSitesOf(game);
    expect(goldOverOneTick(alice)).toBe(0n);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(75n);
    alice.conquer(second.tile);
    expect(goldOverOneTick(alice)).toBe(150n);
  });

  test("a mine is captured with its tile", async () => {
    await start();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(75n);
    bob.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(bob)).toBe(75n);
  });

  test("an unowned or flooded mine pays no one", async () => {
    await start();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    alice.relinquish(mine.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
    game.queueWaterConversion(mine.tile, true);
    game.executeNextTick();
    expect(game.isWater(mine.tile)).toBe(true);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("scales with the gold multiplier like passive income", async () => {
    await start({ goldMultiplier: 2 });
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(150n);
  });

  test("an oil field pays its tile's owner 112 gold per tick, 224 at double gold", async () => {
    await start();
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    expect(RESOURCE_SITE_INFO[oil.kind].goldPerTick).toBe(112n);
    alice.conquer(oil.tile);
    expect(goldOverOneTick(alice)).toBe(112n);
    bob.conquer(oil.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(bob)).toBe(112n);

    await start({ goldMultiplier: 2 });
    const [doubled] = sitesOfKind(ResourceSiteKind.OilField);
    alice.conquer(doubled.tile);
    expect(goldOverOneTick(alice)).toBe(224n);
  });

  test("a flooded oil field pays no one", async () => {
    await start();
    const [oil] = sitesOfKind(ResourceSiteKind.OilField);
    alice.conquer(oil.tile);
    alice.relinquish(oil.tile);
    game.queueWaterConversion(oil.tile, true);
    game.executeNextTick();
    expect(game.isWater(oil.tile)).toBe(true);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("fishing grounds pay whoever holds the nearest coast 75 gold per tick, 150 at double gold", async () => {
    await start({}, true, "world");
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    expect(game.isWater(fishing.tile)).toBe(true);
    // Its own water tile pays no one.
    expect(goldOverOneTick(alice)).toBe(0n);
    alice.conquer(holderTile(fishing));
    expect(goldOverOneTick(alice)).toBe(75n);
    bob.conquer(holderTile(fishing));
    expect(goldOverOneTick(alice)).toBe(0n);
    expect(goldOverOneTick(bob)).toBe(75n);

    await start({ goldMultiplier: 2 }, true, "world");
    const [doubled] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    alice.conquer(holderTile(doubled));
    expect(goldOverOneTick(alice)).toBe(150n);
  });

  test("fishing grounds follow the coast when their coast tile is flooded", async () => {
    await start({}, true, "world");
    const [fishing] = sitesOfKind(ResourceSiteKind.FishingGrounds);
    const coast = holderTile(fishing);
    alice.conquer(coast);
    expect(goldOverOneTick(alice)).toBe(75n);
    // Unowned, it pays no one.
    alice.relinquish(coast);
    expect(goldOverOneTick(alice)).toBe(0n);
    game.queueWaterConversion(coast, true);
    game.executeNextTick();
    expect(game.isWater(coast)).toBe(true);
    const next = holderTile(fishing);
    expect(next).not.toBe(coast);
    bob.conquer(next);
    expect(goldOverOneTick(bob)).toBe(75n);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("pays nothing during the spawn phase but is already placed", async () => {
    await start({}, false);
    expect(game.inSpawnPhase()).toBe(true);
    const [mine] = resourceSitesOf(game);
    expect(mine).toBeDefined();
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(0n);
  });

  test("tells the view where the sites are, and again every second", async () => {
    game = await setup("plains", {}, []);
    game.addExecution(new ResourceSiteExecution("SITES001"));
    const first = game.executeNextTick()[GameUpdateType.ResourceSites];
    expect(first).toHaveLength(1);
    expect(unpackResourceSites(first[0].sites)).toEqual(resourceSitesOf(game));
    let resent = 0;
    for (let i = 0; i < RESOURCE_SITES_RESEND_TICKS * 3; i++) {
      resent += game.executeNextTick()[GameUpdateType.ResourceSites].length;
    }
    expect(resent).toBe(3);
  });

  test("snapshots and restores mid-game", async () => {
    await start();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    executeTicks(game, 5);
    const restored = await expectSnapshotRoundTrip(game, "plains", 20);
    expect(resourceSitesOf(restored)).toEqual(resourceSitesOf(game));
  });

  test("snapshots and restores every kind, held and paying", async () => {
    await start({}, true, "world");
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
    expect(restored.player("alice").gold() - before).toBe(150n);
  });
});

describe("the resource sites setting", () => {
  test("on: the game places every kind away from the nations' spawns", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ resourceSites: true }),
    );
    runner.game.executeNextTick();
    const sites = resourceSitesOf(runner.game);
    const landTiles = runner.game.map().numLandTiles();
    for (const kind of RESOURCE_SITE_KINDS) {
      expect(sites.filter((s) => s.kind === kind).length).toBe(
        resourceSiteCount(landTiles, kind),
      );
    }
    expect(runner.game.nations().length).toBeGreaterThan(0);
    for (const s of sites) {
      const min = s.kind === ResourceSiteKind.OilField ? 50 : 25;
      for (const n of runner.game.nations()) {
        if (n.spawnCell === undefined) continue;
        const dx = runner.game.x(s.tile) - n.spawnCell.x;
        const dy = runner.game.y(s.tile) - n.spawnCell.y;
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(min * min);
      }
    }
  });

  test("off: no sites", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ resourceSites: false }),
    );
    runner.game.executeNextTick();
    expect(resourceSitesOf(runner.game)).toEqual([]);
    expect(
      runner.game.executions().some((e) => e instanceof ResourceSiteExecution),
    ).toBe(false);
  });
});

describe("nations value targets holding mines", () => {
  test("a target holding mines ranks as weaker, more so on harder difficulties", async () => {
    const weighted = async (difficulty: Difficulty, mines: number) => {
      await start({ difficulty });
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
    await start({ difficulty: Difficulty.Hard }, true, "world");
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
