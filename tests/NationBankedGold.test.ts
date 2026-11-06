/**
 * Banked gold (spec: Gold from conquering nations): a nation spends gold
 * above 3x the price of its next build on city and port upgrades, so its
 * treasury isn't a jackpot for whoever conquers it. A Hard or Impossible
 * nation keeps the nuke money it is about to spend.
 */
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import {
  BANKED_GOLD_NEXT_BUILD_MULTIPLE,
  NationStructureBehavior,
} from "@openfront/engine/execution/nation/NationStructureBehavior";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { vi } from "vitest";
import { createGame, L } from "./core/pathfinding/_fixtures";

/**
 * A landlocked 100x100 nation with `cities` cities and a missile silo, so
 * its next build is a city and it saves up for nukes. No factories or SAMs,
 * so nothing else is due.
 */
function setupNation(difficulty: Difficulty, cities: number) {
  const size = 100;
  const game = createGame(
    { width: size, height: size, grid: new Array(size * size).fill(L) },
    {
      difficulty,
      disabledUnits: [UnitType.Factory, UnitType.SAMLauncher],
    },
  );
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, "nation_id"),
  );
  game.map().forEachTile((tile) => nation.conquer(tile));
  for (let i = 0; i < cities; i++) {
    nation.buildUnit(UnitType.City, game.ref(10 + 15 * i, 10), {});
  }
  nation.buildUnit(UnitType.MissileSilo, game.ref(50, 80), {});
  const behavior = new NationStructureBehavior(
    new PseudoRandom(7),
    game,
    nation,
  );
  const spy = vi.spyOn(game, "addExecution");
  const calls = () => spy.mock.calls.map((c) => c[0]);
  const built = () =>
    calls()
      .filter((e) => e instanceof ConstructionExecution)
      .map((e) => e["constructionType"]);
  const upgrades = () =>
    calls()
      .filter((e) => e instanceof UpgradeStructureExecution)
      .map((e) => ({
        type: game
          .units()
          .find((u) => u.id() === e["unitId"])
          ?.type(),
        levels: e["amount"],
      }));
  const gold = (amount: bigint) => {
    nation.removeGold(nation.gold());
    nation.addGold(amount);
  };
  const cityPrice = () => game.unitInfo(UnitType.City).cost(game, nation);
  return { game, nation, behavior, built, upgrades, gold, cityPrice };
}

describe("Nations spend banked gold", () => {
  it("above 3x the next build's price on city upgrades", () => {
    expect(BANKED_GOLD_NEXT_BUILD_MULTIPLE).toBe(3n);
    const { behavior, built, upgrades, gold, cityPrice } = setupNation(
      Difficulty.Easy,
      4,
    );
    // Its next build is a 1M city that feels like 5M while it saves up.
    expect(cityPrice()).toBe(1_000_000n);
    gold(cityPrice() * 3n + cityPrice());
    expect(behavior.handleStructures()).toBe(true);
    expect(built()).toEqual([]);
    expect(upgrades()).toEqual([{ type: UnitType.City, levels: 1 }]);
  });

  it("buys as many levels as the gold above 3x pays for", () => {
    // Six cities: the next feels like 5.8M while it saves up.
    const { behavior, upgrades, gold, cityPrice } = setupNation(
      Difficulty.Medium,
      6,
    );
    gold(cityPrice() * 3n + cityPrice() * 2n + 500_000n);
    behavior.handleStructures();
    expect(upgrades()).toEqual([{ type: UnitType.City, levels: 2 }]);
  });

  it("keeps up to 3x the next build's price", () => {
    const { behavior, built, upgrades, gold, cityPrice } = setupNation(
      Difficulty.Easy,
      4,
    );
    gold(cityPrice() * 3n + cityPrice() - 1n);
    expect(behavior.handleStructures()).toBe(false);
    expect(built()).toEqual([]);
    expect(upgrades()).toEqual([]);
  });

  it("Hard keeps the nuke money it can save up within its horizon", () => {
    const { nation, behavior, built, upgrades, gold, cityPrice } = setupNation(
      Difficulty.Hard,
      6,
    );
    // Lifetime income that puts five hydrogen bombs within 5 minutes.
    nation.addGold(20_000_000n);
    nation.removeGold(20_000_000n);
    gold(cityPrice() * 4n + cityPrice() / 2n);
    expect(behavior.handleStructures()).toBe(false);
    expect(built()).toEqual([]);
    expect(upgrades()).toEqual([]);
  });
});
