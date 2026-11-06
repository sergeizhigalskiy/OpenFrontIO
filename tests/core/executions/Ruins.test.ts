import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  claimsRuins,
  LAND_TILES_PER_RUIN,
  RUIN_GOLD_INCOME_TICKS,
  RUIN_MIN_SPACING,
  RUIN_MIN_SPAWN_DISTANCE,
  RUIN_REWARD_KINDS,
  RUIN_TROOP_REWARD_PERCENT,
  ruinGoldReward,
  RuinReward,
  ruinCount,
  ruinTroopReward,
  RUINS_MAX_COUNT,
  RUINS_MIN_COUNT,
} from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import {
  placeRuins,
  RuinsExecution,
} from "@openfront/engine/execution/RuinsExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { GameSnapshot } from "@openfront/engine/game/GameImpl";
import { snapshotGameData } from "@openfront/engine/snapshot/GameSnapshot";
import { setGold } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 tiles of open land.
const MAP = "big_plains";

async function twoPlayers(
  config: Partial<GameConfig> = {},
): Promise<{ game: Game; a: Player; b: Player }> {
  const game = await setup(MAP, config, [
    new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    new PlayerInfo("b", PlayerType.Human, "c_b", "b"),
  ]);
  return { game, a: game.player("a"), b: game.player("b") };
}

function dist(game: Game, t1: number, t2: number): number {
  return Math.sqrt(game.euclideanDistSquared(t1, t2));
}

describe("ruins: count and placement", () => {
  test("one per 120,000 land tiles, clamped to 8-20", () => {
    expect(LAND_TILES_PER_RUIN).toBe(120_000);
    expect(RUINS_MIN_COUNT).toBe(8);
    expect(RUINS_MAX_COUNT).toBe(20);
    expect(ruinCount(0)).toBe(8);
    // Iceland.
    expect(ruinCount(1_069_645)).toBe(8);
    expect(ruinCount(12 * 120_000)).toBe(12);
    expect(ruinCount(15 * 120_000 - 1)).toBe(14);
    // The full-size World map.
    expect(ruinCount(2_317_767)).toBe(19);
    expect(ruinCount(20 * 120_000)).toBe(20);
    expect(ruinCount(10_000_000)).toBe(20);
  });

  test("ruins sit on free land, 25 tiles from every spawn and from each other", async () => {
    const { game, a, b } = await twoPlayers();
    a.conquer(game.ref(30, 30));
    a.setSpawnTile(game.ref(30, 30));
    b.conquer(game.ref(150, 150));
    b.setSpawnTile(game.ref(150, 150));

    const ruins = placeRuins(game, new PseudoRandom(7));
    // big_plains has room for the minimum.
    expect(ruins).toHaveLength(ruinCount(game.numLandTiles()));
    for (const r of ruins) {
      expect(game.isLand(r.tile)).toBe(true);
      expect(game.isImpassable(r.tile)).toBe(false);
      expect(game.hasOwner(r.tile)).toBe(false);
      for (const spawn of [a.spawnTile()!, b.spawnTile()!]) {
        expect(dist(game, r.tile, spawn)).toBeGreaterThanOrEqual(
          RUIN_MIN_SPAWN_DISTANCE,
        );
      }
      for (const other of ruins) {
        if (other === r) continue;
        expect(dist(game, r.tile, other.tile)).toBeGreaterThanOrEqual(
          RUIN_MIN_SPACING,
        );
      }
    }
  });

  test("a ruin holds gold or troops, never a defense post", async () => {
    expect(RUIN_REWARD_KINDS).toBe(2);
    expect(Object.keys(RuinReward).filter((k) => isNaN(Number(k)))).toEqual([
      "Gold",
      "Troops",
    ]);
    const { game } = await twoPlayers();
    const seen = new Set<RuinReward>();
    for (const seed of [1, 2, 3, 4]) {
      for (const r of placeRuins(game, new PseudoRandom(seed))) {
        seen.add(r.reward);
      }
    }
    expect([...seen].sort()).toEqual([RuinReward.Gold, RuinReward.Troops]);
  });

  test("the same seed places the same ruins with the same rewards", async () => {
    const { game } = await twoPlayers();
    const again = await twoPlayers();
    const first = placeRuins(game, new PseudoRandom(1234));
    expect(placeRuins(again.game, new PseudoRandom(1234))).toEqual(first);
    expect(placeRuins(game, new PseudoRandom(99))).not.toEqual(first);
  });

  test("a map with no room gets fewer, never too close", async () => {
    // 16x16, half of it sea: at 25 tiles apart only one fits, on land.
    const game = await setup("half_land_half_ocean");
    const ruins = placeRuins(game, new PseudoRandom(3));
    expect(ruins).toHaveLength(1);
    expect(game.isLand(ruins[0].tile)).toBe(true);
  });

  test("RuinsExecution waits for the spawn phase to end and its spawns to land, then places them once", async () => {
    const game = await setup(MAP, {}, [], undefined, undefined, false);
    game.addExecution(new RuinsExecution("ruins_game"));
    executeTicks(game, 3);
    expect(game.ruins().size).toBe(0);

    game.endSpawnPhase();
    // A spawn picked on the phase's last tick lands this tick.
    expect(game.executeNextTick()[GameUpdateType.Ruins]).toHaveLength(0);
    expect(game.ruins().size).toBe(0);
    const updates = game.executeNextTick();
    expect(game.ruins().size).toBe(ruinCount(game.numLandTiles()));
    // The view learns where they are, not what they hold.
    const sent = updates[GameUpdateType.Ruins];
    expect(sent).toHaveLength(1);
    expect(sent[0].tiles).toEqual([...game.ruins().keys()]);
    expect(Object.keys(sent[0])).toEqual(["type", "tiles"]);

    const placed = [...game.ruins()];
    executeTicks(game, 5);
    expect([...game.ruins()]).toEqual(placed);
  });
});

describe("ruins: rewards", () => {
  async function ruinNextTo(reward: RuinReward, goldMultiplier?: number) {
    const { game, a, b } = await twoPlayers(
      goldMultiplier === undefined ? {} : { goldMultiplier },
    );
    a.conquer(game.ref(100, 100));
    const tile = game.ref(101, 100);
    game.addRuins([{ tile, reward }]);
    return { game, a, b, tile };
  }

  test("a gold burst pays 60 s of the claimer's base income: 60,000 gold", async () => {
    expect(RUIN_GOLD_INCOME_TICKS).toBe(600);
    const { game, a, tile } = await ruinNextTo(RuinReward.Gold);
    expect(game.config().goldAdditionRate(a)).toBe(100n);
    setGold(a, 0n);
    const shown = vi.spyOn(game, "displayMessage");
    a.conquer(tile);
    expect(a.gold()).toBe(60_000n);
    expect(shown).toHaveBeenCalledWith(
      "events_display.ruins_found_gold",
      expect.anything(),
      a.id(),
      undefined,
      { gold: "60.0K" },
    );
  });

  test("the gold burst follows the gold multiplier", async () => {
    for (const [multiplier, gold] of [
      [2, 120_000n],
      [0.5, 30_000n],
    ] as const) {
      const { a, tile } = await ruinNextTo(RuinReward.Gold, multiplier);
      setGold(a, 0n);
      a.conquer(tile);
      expect(a.gold()).toBe(gold);
    }
    expect(ruinGoldReward(250n)).toBe(150_000n);
  });

  test("a troop burst adds 10% of max troops", async () => {
    const { game, a, tile } = await ruinNextTo(RuinReward.Troops);
    a.setTroops(1_000);
    const shown = vi.spyOn(game, "displayMessage");
    a.conquer(tile);
    const max = game.config().maxTroops(a);
    expect(a.troops()).toBe(
      1_000 + Math.floor((max * RUIN_TROOP_REWARD_PERCENT) / 100),
    );
    expect(shown.mock.calls[0][0]).toBe("events_display.ruins_found_troops");
  });

  test("a troop burst never goes past the troop cap", async () => {
    const { game, a, tile } = await ruinNextTo(RuinReward.Troops);
    a.conquer(tile);
    const max = Math.floor(game.config().maxTroops(a));
    expect(ruinTroopReward(max - 10, max)).toBe(10);
    expect(ruinTroopReward(max, max)).toBe(0);
    expect(ruinTroopReward(max + 50, max)).toBe(0);
  });

  test("no ruin builds a free defense post", async () => {
    for (const reward of [RuinReward.Gold, RuinReward.Troops]) {
      const { a, tile } = await ruinNextTo(reward);
      a.conquer(tile);
      expect(a.units(UnitType.DefensePost)).toHaveLength(0);
    }
  });

  test("a saved game's defense post ruin loads as a gold ruin", async () => {
    const { game } = await twoPlayers();
    game.addRuins([
      { tile: game.ref(5, 5), reward: RuinReward.Troops },
      { tile: game.ref(60, 60), reward: RuinReward.Gold },
    ]);
    const d = { ...(snapshotGameData(game).game.d as Record<string, unknown>) };
    d.ruins = [
      { tile: game.ref(5, 5), reward: 2 },
      { tile: game.ref(60, 60), reward: 1 },
    ];
    expect(readVersioned(GameSnapshot, { v: 4, d }).ruins).toEqual([
      { tile: game.ref(5, 5), reward: RuinReward.Gold },
      { tile: game.ref(60, 60), reward: RuinReward.Troops },
    ]);
  });
});

describe("ruins: claiming", () => {
  test("only humans and nations claim ruins", () => {
    expect(claimsRuins(PlayerType.Human)).toBe(true);
    expect(claimsRuins(PlayerType.Nation)).toBe(true);
    expect(claimsRuins(PlayerType.Bot)).toBe(false);
  });

  test("the first to take the tile from free land claims it, and it is gone", async () => {
    const { game, a, b } = await twoPlayers();
    const tile = game.ref(60, 60);
    const other = game.ref(140, 140);
    game.addRuins([
      { tile, reward: RuinReward.Gold },
      { tile: other, reward: RuinReward.Gold },
    ]);
    setGold(a, 0n);
    setGold(b, 0n);
    const sent = vi.spyOn(game, "addUpdate");

    a.conquer(tile);
    expect(a.gold()).toBe(60_000n);
    expect(game.ruins().has(tile)).toBe(false);
    // The view is told the ruin is gone.
    expect(sent).toHaveBeenCalledWith({
      type: GameUpdateType.Ruins,
      tiles: [other],
    });

    // Taking it from its claimer, or again after it lapses, pays nothing.
    const goldA = a.gold();
    b.conquer(tile);
    expect(b.gold()).toBe(0n);
    b.relinquish(tile);
    a.conquer(tile);
    expect(a.gold()).toBe(goldA);
  });

  test("a tribe taking the tile leaves the ruin standing; a nation taking it from the tribe claims it", async () => {
    const game = await setup(MAP);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    const tile = game.ref(10, 10);
    game.addRuins([{ tile, reward: RuinReward.Gold }]);
    setGold(tribe, 0n);
    setGold(nation, 0n);
    tribe.conquer(tile);
    expect(tribe.gold()).toBe(0n);
    expect(game.ruins().get(tile)).toBe(RuinReward.Gold);

    nation.conquer(tile);
    expect(nation.gold()).toBe(60_000n);
    expect(game.ruins().size).toBe(0);
  });

  test("a human takes a ruin from a tribe too", async () => {
    const { game, a } = await twoPlayers();
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    const tile = game.ref(10, 10);
    game.addRuins([{ tile, reward: RuinReward.Troops }]);
    tribe.conquer(tile);
    expect(game.ruins().has(tile)).toBe(true);
    a.setTroops(1_000);
    a.conquer(tile);
    expect(a.troops()).toBeGreaterThan(1_000);
    expect(game.ruins().has(tile)).toBe(false);
  });

  test("a ruin whose land floods is gone, unclaimed", async () => {
    const game = await setup(MAP, { waterNukes: true });
    const tile = game.ref(10, 10);
    game.addRuins([{ tile, reward: RuinReward.Gold }]);
    game.queueWaterConversion(tile);
    let flooded = false;
    for (let i = 0; i < 40 && !flooded; i++) {
      const updates = game.executeNextTick();
      flooded = updates[GameUpdateType.Ruins].length > 0;
    }
    expect(flooded).toBe(true);
    expect(game.ruins().size).toBe(0);
  });
});
