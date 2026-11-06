/**
 * Nation AI for defense lines: nations upgrade defense posts on threatened
 * borders, more readily on higher difficulty.
 */
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import {
  DEFENSE_POST_UPGRADE_GOLD_FACTOR,
  NationStructureBehavior,
} from "@openfront/engine/execution/nation/NationStructureBehavior";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
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
