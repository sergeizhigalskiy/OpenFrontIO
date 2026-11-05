import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  RESOURCE_SITES_RESEND_TICKS,
  resourceSiteCount,
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

async function start(
  config: Partial<GameConfig> = {},
  autoEndSpawnPhase = true,
): Promise<void> {
  game = await setup(
    "plains",
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

describe("ResourceSiteExecution", () => {
  test("places the sites when it starts", async () => {
    await start();
    const sites = resourceSitesOf(game);
    expect(sites.length).toBe(6);
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

  test("a mine the rising tide floods stops paying, like one a canal digs out", async () => {
    await start();
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(75n);
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
    const [mine] = resourceSitesOf(game);
    alice.conquer(mine.tile);
    expect(goldOverOneTick(alice)).toBe(150n);
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
});

describe("the resource sites setting", () => {
  test("on: the game places sites away from the nations' spawns", async () => {
    const runner = await createScriptedRunner(
      "world",
      scriptedGameStart({ resourceSites: true }),
    );
    runner.game.executeNextTick();
    const sites = resourceSitesOf(runner.game);
    expect(sites.length).toBe(
      resourceSiteCount(runner.game.map().numLandTiles()),
    );
    expect(runner.game.nations().length).toBeGreaterThan(0);
    for (const s of sites) {
      for (const n of runner.game.nations()) {
        if (n.spawnCell === undefined) continue;
        const dx = runner.game.x(s.tile) - n.spawnCell.x;
        const dy = runner.game.y(s.tile) - n.spawnCell.y;
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(25 * 25);
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

  test("without sites the ranking is plain troops", async () => {
    game = await setup("plains", { difficulty: Difficulty.Impossible }, [
      new PlayerInfo("bob", PlayerType.Human, "client_b", "bob"),
    ]);
    bob = game.player("bob");
    bob.setTroops(1234);
    expect(mineWeightedTroops(game, bob)).toBe(1234);
  });
});
