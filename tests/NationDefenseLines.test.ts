/**
 * Nation AI for defense lines: posts have one level (as upstream), so a
 * nation whose threatened front is already covered never upgrades a post;
 * it builds where cover is missing, or does nothing.
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
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Execution, Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { createGame, L } from "./core/pathfinding/_fixtures";

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

describe("nation defense posts: one level, no upgrades", () => {
  function behavior(game: Game, nation: Player, random = new PseudoRandom(42)) {
    return new NationStructureBehavior(random, game, nation) as unknown as {
      tryBuildDefensePost(): boolean;
      maybeBuildProactiveDefensePost(): boolean;
    };
  }

  /** The enemy attacks with 40% of the nation's troops: one post is enough. */
  function underAttack(difficulty: Difficulty) {
    const g = frontGame(difficulty);
    g.game.addExecution(
      new AttackExecution(4_000, g.enemy, g.nation.id(), null, false),
    );
    for (let i = 0; i < 3; i++) g.game.executeNextTick();
    expect(g.nation.incomingAttacks()).toHaveLength(1);
    return g;
  }

  test("under attack with the front uncovered, builds a post behind it", () => {
    for (const difficulty of [Difficulty.Hard, Difficulty.Impossible]) {
      const { game, nation } = underAttack(difficulty);
      const spy = vi.spyOn(game, "addExecution");
      expect(behavior(game, nation).tryBuildDefensePost()).toBe(true);
      expect(added(spy, ConstructionExecution)).toHaveLength(1);
      expect(added(spy, UpgradeStructureExecution)).toEqual([]);
    }
  });

  test("under attack with the front covered, neither upgrades nor builds", () => {
    for (const difficulty of [
      Difficulty.Medium,
      Difficulty.Hard,
      Difficulty.Impossible,
    ]) {
      const { game, nation } = underAttack(difficulty);
      nation.buildUnit(UnitType.DefensePost, game.ref(100, 45), {});
      const random = new PseudoRandom(42);
      vi.spyOn(random, "chance").mockReturnValue(true);
      const spy = vi.spyOn(game, "addExecution");
      expect(behavior(game, nation, random).tryBuildDefensePost()).toBe(false);
      expect(added(spy, UpgradeStructureExecution)).toEqual([]);
      expect(added(spy, ConstructionExecution)).toEqual([]);
    }
  });

  test("Hard leaves a threatening neighbor's covered border alone", () => {
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
    nation.buildUnit(UnitType.DefensePost, game.ref(100, 35), {});
    const spy = vi.spyOn(game, "addExecution");
    expect(behavior(game, nation).maybeBuildProactiveDefensePost()).toBe(false);
    expect(added(spy, UpgradeStructureExecution)).toEqual([]);
    expect(added(spy, ConstructionExecution)).toEqual([]);
  });
});
