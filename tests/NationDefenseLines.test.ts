/**
 * Nation AI for defense lines: nations upgrade defense posts on threatened
 * borders, and build a siege camp when their attack front faces an enemy
 * defense post, more readily on higher difficulty.
 */
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { SIEGE_CAMP_RANGE } from "@openfront/engine-lib/game/Siege";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { isCataclysmHazard } from "@openfront/engine/execution/nation/NationCataclysm";
import {
  considerSiegeCamp,
  NATION_SIEGE_CAMP_CHANCE,
  NATION_SIEGE_CAMP_GOLD_FACTOR,
} from "@openfront/engine/execution/nation/NationSiegeBehavior";
import {
  DEFENSE_POST_UPGRADE_GOLD_FACTOR,
  NationStructureBehavior,
} from "@openfront/engine/execution/nation/NationStructureBehavior";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { VolcanoExecution } from "@openfront/engine/execution/VolcanoExecution";
import { Execution, Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { createGame, L } from "./core/pathfinding/_fixtures";

const DIFFICULTIES = [
  Difficulty.Easy,
  Difficulty.Medium,
  Difficulty.Hard,
  Difficulty.Impossible,
];

/**
 * 200x100 of land. The enemy holds y < 20 and borders the nation along
 * y = 20.
 */
function frontGame(difficulty: Difficulty) {
  const width = 200;
  const height = 100;
  const grid: string[] = new Array(width * height).fill(L);
  const game = createGame({ width, height, grid }, { difficulty });
  game.addPlayer(new PlayerInfo("nation", PlayerType.Nation, null, "nation"));
  game.addPlayer(new PlayerInfo("enemy", PlayerType.Human, null, "enemy"));
  const nation = game.player("nation");
  const enemy = game.player("enemy");
  game.map().forEachTile((tile) => {
    (game.y(tile) < 20 ? enemy : nation).conquer(tile);
  });
  nation.setTroops(10_000);
  nation.addGold(10_000_000n);
  game.endSpawnPhase();
  return { game, nation, enemy };
}

function added<T extends Execution>(
  spy: { mock: { calls: unknown[][] } },
  cls: abstract new (...args: never[]) => T,
): T[] {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((e): e is T => e instanceof cls);
}

function siegeOrders(spy: { mock: { calls: unknown[][] } }): number[] {
  return added(spy, ConstructionExecution)
    .filter((e) => e["constructionType"] === UnitType.SiegeCamp)
    .map((e) => e["tile"] as number);
}

describe("nation siege camps", () => {
  /** The nation attacks the enemy, whose built post covers the front. */
  function siegeSetup(difficulty: Difficulty, post = true) {
    const g = frontGame(difficulty);
    if (post) {
      g.enemy.buildUnit(UnitType.DefensePost, g.game.ref(100, 8), {});
    }
    g.enemy.setTroops(50_000);
    g.game.addExecution(
      new AttackExecution(5_000, g.nation, g.enemy.id(), null, false),
    );
    for (let i = 0; i < 3; i++) g.game.executeNextTick();
    expect(g.nation.outgoingAttacks()).toHaveLength(1);
    return g;
  }

  /** A PRNG whose rolls always pass. */
  function luckyRandom() {
    const random = new PseudoRandom(7);
    vi.spyOn(random, "nextInt").mockReturnValue(0);
    return random;
  }

  test("scales with difficulty: never on Easy, more often and cheaper after", () => {
    expect(NATION_SIEGE_CAMP_CHANCE[Difficulty.Easy]).toBe(0);
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      const easier = DIFFICULTIES[i - 1];
      const harder = DIFFICULTIES[i];
      expect(NATION_SIEGE_CAMP_CHANCE[harder]).toBeGreaterThan(
        NATION_SIEGE_CAMP_CHANCE[easier],
      );
      expect(NATION_SIEGE_CAMP_GOLD_FACTOR[harder]).toBeLessThan(
        NATION_SIEGE_CAMP_GOLD_FACTOR[easier],
      );
    }
  });

  test("builds a camp within reach of the post its attack front faces", () => {
    const { game, nation, enemy } = siegeSetup(Difficulty.Impossible);
    const spy = vi.spyOn(game, "addExecution");
    expect(considerSiegeCamp(game, nation, luckyRandom())).toBe(true);
    const [tile] = siegeOrders(spy);
    expect(game.owner(tile)).toBe(nation);
    const spawn = nation.canBuild(UnitType.SiegeCamp, tile);
    expect(spawn).not.toBe(false);
    const [post] = enemy.units(UnitType.DefensePost);
    expect(
      game.euclideanDistSquared(spawn as number, post.tile()),
    ).toBeLessThanOrEqual(SIEGE_CAMP_RANGE ** 2);

    // The order goes through: the camp stands, and one is enough.
    spy.mockRestore();
    for (let i = 0; i < 3; i++) game.executeNextTick();
    expect(nation.units(UnitType.SiegeCamp)).toHaveLength(1);
    expect(considerSiegeCamp(game, nation, luckyRandom())).toBe(false);
  });

  test("never on Easy, and not without a post on the front", () => {
    for (const [difficulty, post] of [
      [Difficulty.Easy, true],
      [Difficulty.Impossible, false],
    ] as const) {
      const { game, nation } = siegeSetup(difficulty, post);
      const random = new PseudoRandom(7);
      const roll = vi.spyOn(random, "nextInt");
      const spy = vi.spyOn(game, "addExecution");
      expect(considerSiegeCamp(game, nation, random)).toBe(false);
      expect(siegeOrders(spy)).toEqual([]);
      // Nothing to decide, so the PRNG is untouched.
      expect(roll).not.toHaveBeenCalled();
    }
  });

  test("waits for the gold its difficulty asks for", () => {
    const { game, nation } = siegeSetup(Difficulty.Hard);
    nation.removeGold(nation.gold());
    // 2x the 300k price on Hard.
    nation.addGold(599_999n);
    expect(considerSiegeCamp(game, nation, luckyRandom())).toBe(false);
    nation.addGold(1n);
    expect(considerSiegeCamp(game, nation, luckyRandom())).toBe(true);
  });

  test("never camps inside a rumbling volcano's warning ring", () => {
    const g = frontGame(Difficulty.Impossible);
    // The ring (radius 25) covers the whole front near the post.
    const site = g.game.ref(100, 22);
    g.game.addExecution(new VolcanoExecution("siege", [{ x: 100, y: 22 }]));
    for (let i = 0; i < 10_000 && !isCataclysmHazard(g.game, site); i++) {
      g.game.executeNextTick();
    }
    expect(isCataclysmHazard(g.game, site)).toBe(true);

    g.enemy.buildUnit(UnitType.DefensePost, g.game.ref(100, 8), {});
    g.enemy.setTroops(50_000);
    g.game.addExecution(
      new AttackExecution(5_000, g.nation, g.enemy.id(), null, false),
    );
    for (let i = 0; i < 3; i++) g.game.executeNextTick();
    expect(g.nation.outgoingAttacks()).toHaveLength(1);
    expect(isCataclysmHazard(g.game, site)).toBe(true);

    const spy = vi.spyOn(g.game, "addExecution");
    expect(considerSiegeCamp(g.game, g.nation, luckyRandom())).toBe(false);
    expect(siegeOrders(spy)).toEqual([]);
  });

  test("a failed roll builds nothing this time", () => {
    const { game, nation } = siegeSetup(Difficulty.Medium);
    const random = new PseudoRandom(7);
    vi.spyOn(random, "nextInt").mockReturnValue(99);
    const spy = vi.spyOn(game, "addExecution");
    expect(considerSiegeCamp(game, nation, random)).toBe(false);
    expect(siegeOrders(spy)).toEqual([]);
  });
});

describe("nation defense post upgrades", () => {
  function behavior(game: Game, nation: Player, random = new PseudoRandom(42)) {
    return new NationStructureBehavior(random, game, nation) as unknown as {
      tryBuildDefensePost(): boolean;
      maybeBuildProactiveDefensePost(): boolean;
    };
  }

  /** The enemy attacks with 40% of the nation's troops: one post is enough. */
  function underAttack(difficulty: Difficulty) {
    const g = frontGame(difficulty);
    const post = g.nation.buildUnit(
      UnitType.DefensePost,
      g.game.ref(100, 45),
      {},
    );
    g.game.addExecution(
      new AttackExecution(4_000, g.enemy, g.nation.id(), null, false),
    );
    for (let i = 0; i < 3; i++) g.game.executeNextTick();
    expect(g.nation.incomingAttacks()).toHaveLength(1);
    return { ...g, post };
  }

  function upgrades(spy: { mock: { calls: unknown[][] } }) {
    return added(spy, UpgradeStructureExecution).map((e) => e["unitId"]);
  }

  test("the gold asked for falls with difficulty; Easy never upgrades", () => {
    expect(DEFENSE_POST_UPGRADE_GOLD_FACTOR[Difficulty.Easy]).toBe(Infinity);
    for (let i = 1; i < DIFFICULTIES.length; i++) {
      expect(DEFENSE_POST_UPGRADE_GOLD_FACTOR[DIFFICULTIES[i]]).toBeLessThan(
        DEFENSE_POST_UPGRADE_GOLD_FACTOR[DIFFICULTIES[i - 1]],
      );
    }
  });

  test("under attack with the front covered, upgrades the post there instead of building", () => {
    const { game, nation, post } = underAttack(Difficulty.Hard);
    const spy = vi.spyOn(game, "addExecution");
    expect(behavior(game, nation).tryBuildDefensePost()).toBe(true);
    expect(upgrades(spy)).toEqual([post.id()]);
    expect(added(spy, ConstructionExecution)).toEqual([]);
  });

  test("stops at level 3", () => {
    const { game, nation, post } = underAttack(Difficulty.Impossible);
    post.increaseLevel();
    post.increaseLevel();
    const spy = vi.spyOn(game, "addExecution");
    expect(behavior(game, nation).tryBuildDefensePost()).toBe(false);
    expect(upgrades(spy)).toEqual([]);
  });

  test("Medium needs twice the price in hand", () => {
    const { game, nation, post } = underAttack(Difficulty.Medium);
    const random = new PseudoRandom(42);
    vi.spyOn(random, "chance").mockReturnValue(true);
    nation.removeGold(nation.gold());
    // The next post level costs 100k.
    nation.addGold(199_999n);
    const spy = vi.spyOn(game, "addExecution");
    expect(behavior(game, nation, random).tryBuildDefensePost()).toBe(false);
    nation.addGold(1n);
    expect(behavior(game, nation, random).tryBuildDefensePost()).toBe(true);
    expect(upgrades(spy)).toEqual([post.id()]);
  });

  test("Hard upgrades the post on a threatening neighbor's border before an attack", () => {
    const { game, nation, enemy } = frontGame(Difficulty.Hard);
    for (const [x, y] of [
      [60, 90],
      [120, 90],
      [60, 60],
      [120, 60],
    ]) {
      nation.buildUnit(UnitType.City, game.ref(x, y), {});
    }
    enemy.setTroops(20_000);
    nation.updateRelation(enemy, -100);
    const post = nation.buildUnit(UnitType.DefensePost, game.ref(100, 35), {});
    const spy = vi.spyOn(game, "addExecution");
    expect(behavior(game, nation).maybeBuildProactiveDefensePost()).toBe(true);
    expect(upgrades(spy)).toEqual([post.id()]);
    expect(added(spy, ConstructionExecution)).toEqual([]);
  });
});
