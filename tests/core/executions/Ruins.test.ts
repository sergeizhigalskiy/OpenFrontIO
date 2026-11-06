import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  LAND_TILES_PER_RUIN,
  RUIN_GOLD_REWARD,
  RUIN_MIN_SPACING,
  RUIN_MIN_SPAWN_DISTANCE,
  RUIN_TROOP_REWARD_PERCENT,
  RuinReward,
  ruinCount,
  ruinTroopReward,
  RUINS_MAX_COUNT,
  RUINS_MIN_COUNT,
} from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import {
  placeRuins,
  RuinsExecution,
} from "@openfront/engine/execution/RuinsExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setGold, structure } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 tiles of open land.
const MAP = "big_plains";

async function twoPlayers(): Promise<{ game: Game; a: Player; b: Player }> {
  const game = await setup(MAP, {}, [
    new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    new PlayerInfo("b", PlayerType.Human, "c_b", "b"),
  ]);
  return { game, a: game.player("a"), b: game.player("b") };
}

function dist(game: Game, t1: number, t2: number): number {
  return Math.sqrt(game.euclideanDistSquared(t1, t2));
}

describe("ruins: count and placement", () => {
  test("the count scales with land, clamped to 15-30", () => {
    expect(ruinCount(0)).toBe(RUINS_MIN_COUNT);
    expect(ruinCount(400_000)).toBe(RUINS_MIN_COUNT);
    expect(ruinCount(RUINS_MIN_COUNT * LAND_TILES_PER_RUIN)).toBe(15);
    expect(ruinCount(20 * LAND_TILES_PER_RUIN)).toBe(20);
    expect(ruinCount(25 * LAND_TILES_PER_RUIN + 1)).toBe(25);
    expect(ruinCount(RUINS_MAX_COUNT * LAND_TILES_PER_RUIN)).toBe(30);
    expect(ruinCount(10_000_000)).toBe(RUINS_MAX_COUNT);
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
    // Every reward kind turns up.
    expect(new Set(ruins.map((r) => r.reward)).size).toBe(3);
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

  test("RuinsExecution waits for the spawn phase to end, then places them once", async () => {
    const game = await setup(MAP, {}, [], undefined, undefined, false);
    game.addExecution(new RuinsExecution("ruins_game"));
    executeTicks(game, 3);
    expect(game.ruins().size).toBe(0);

    game.endSpawnPhase();
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
  async function ruinNextTo(reward: RuinReward) {
    const { game, a, b } = await twoPlayers();
    a.conquer(game.ref(100, 100));
    const tile = game.ref(101, 100);
    game.addRuins([{ tile, reward }]);
    return { game, a, b, tile };
  }

  test("a gold burst pays 150,000 gold and tells the claimer", async () => {
    const { game, a, tile } = await ruinNextTo(RuinReward.Gold);
    setGold(a, 0n);
    const shown = vi.spyOn(game, "displayMessage");
    a.conquer(tile);
    expect(a.gold()).toBe(BigInt(RUIN_GOLD_REWARD));
    expect(shown).toHaveBeenCalledWith(
      "events_display.ruins_found_gold",
      expect.anything(),
      a.id(),
      undefined,
      { gold: "150K" },
    );
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

  test("a defense post is built at once, free, on the ruin tile", async () => {
    const { game, a, tile } = await ruinNextTo(RuinReward.DefensePost);
    setGold(a, 0n);
    const added = vi.spyOn(game, "addExecution");
    a.conquer(tile);
    const posts = a.units(UnitType.DefensePost);
    expect(posts).toHaveLength(1);
    expect(posts[0].tile()).toBe(tile);
    expect(posts[0].level()).toBe(1);
    expect(posts[0].isUnderConstruction()).toBe(false);
    expect(a.gold()).toBe(0n);
    // A gift, so the next post isn't dearer.
    expect(a.unitsConstructed(UnitType.DefensePost)).toBe(0);
    expect(added.mock.calls[0][0]).toBeInstanceOf(DefensePostExecution);
  });

  test("a defense post that can't stand there is a gold burst instead", async () => {
    const { game, a, tile } = await ruinNextTo(RuinReward.DefensePost);
    // A structure closer than the minimum spacing blocks it.
    structure(game, a, UnitType.City, game.ref(100, 100));
    setGold(a, 0n);
    a.conquer(tile);
    expect(a.units(UnitType.DefensePost)).toHaveLength(0);
    expect(a.gold()).toBe(BigInt(RUIN_GOLD_REWARD));
  });

  test("with defense posts disabled, a defense post ruin pays gold", async () => {
    const game = await setup(MAP, { disabledUnits: [UnitType.DefensePost] }, [
      new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    ]);
    const a = game.player("a");
    a.conquer(game.ref(50, 50));
    const tile = game.ref(51, 50);
    game.addRuins([{ tile, reward: RuinReward.DefensePost }]);
    setGold(a, 0n);
    a.conquer(tile);
    expect(a.gold()).toBe(BigInt(RUIN_GOLD_REWARD));
  });
});

describe("ruins: claiming", () => {
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
    expect(a.gold()).toBe(BigInt(RUIN_GOLD_REWARD));
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

  test("a nation or tribe expanding over it claims it like anyone", async () => {
    const game = await setup(MAP);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    const tile = game.ref(10, 10);
    game.addRuins([{ tile, reward: RuinReward.Gold }]);
    const before = tribe.gold();
    tribe.conquer(tile);
    expect(tribe.gold()).toBe(before + BigInt(RUIN_GOLD_REWARD));
    expect(game.ruins().size).toBe(0);
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
