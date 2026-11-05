/**
 * The attack math moved from EngineConfig to engine-lib (AttackLogic.ts) so
 * the client's attack forecast can run it. These tests pin that:
 *  - the moved attackLogic is bit-identical to the old EngineConfig code
 *    (a verbatim copy lives below) over a wide spread of inputs;
 *  - the forecast the hover card shows is exactly what AttackExecution
 *    computes for the same tile, defense posts and siege camps included;
 *  - the forecast's front size is the border an attack starts with.
 * AttackLogicGolden and AttackScenarios pin the engine's own numbers.
 */
import {
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { log } from "@openfront/engine-lib/DetMath";
import {
  ATTACK_FRONT_JITTER_MEAN,
  AttackForecast,
  attackForecast,
  attackFrontSizes,
} from "@openfront/engine-lib/game/AttackForecast";
import {
  AttackLogicInput,
  AttackLogicResult,
} from "@openfront/engine-lib/game/AttackLogic";
import {
  SIEGE_CAMP_POST_DEFENSE_BONUS,
  SIEGE_CAMP_POST_SPEED_BONUS,
} from "@openfront/engine-lib/game/Siege";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { sigmoid, within } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

// ---------------------------------------------------------------------------
// The pre-move EngineConfig.attackLogic, verbatim (tunables inlined).
// ---------------------------------------------------------------------------

type LegacyInput = Omit<AttackLogicInput, "siegeCampReducesDefensePost">;

function legacyLargeTerritoryBonus(numTiles: number, depth: number): number {
  return 1 - depth * sigmoid(log(numTiles), 2.5, log(300_000));
}

function legacyTerrainAttackBase(terrain: TerrainType) {
  switch (terrain) {
    case TerrainType.Plains:
      return { mag: 80, tileCost: 16.5 };
    case TerrainType.Highland:
      return { mag: 100, tileCost: 20 };
    case TerrainType.Mountain:
      return { mag: 120, tileCost: 25 };
    default:
      throw new Error("unsupported");
  }
}

function legacyAttackLogic(input: LegacyInput): AttackLogicResult {
  const { attackTroops, attacker, defender } = input;
  let { mag, tileCost } = legacyTerrainAttackBase(input.terrain);
  if (defender !== null && input.defenderHasDefensePost) {
    mag *= 5;
    tileCost *= 3;
  }
  if (input.falloutRatio !== null) {
    const fallout = 5 - input.falloutRatio * 2;
    mag *= fallout;
    tileCost *= fallout;
  }
  if (defender === null) {
    const tickBudget = input.borderSize * 2;
    return {
      attackerTroopLoss: mag / (attacker.type === PlayerType.Bot ? 10 : 5),
      defenderTroopLoss: 0,
      tickFraction:
        within((2000 * tileCost) / attackTroops, 5, 100) / tickBudget,
    };
  }
  if (defender.isDisconnectedTeammate) mag = 0;
  if (
    (attacker.type === PlayerType.Human ||
      attacker.type === PlayerType.Nation) &&
    defender.type === PlayerType.Bot
  ) {
    mag *= 0.7;
  }
  const largeAttackerBonus = legacyLargeTerritoryBonus(attacker.numTiles, 0.7);
  const largeDefenderBonus = legacyLargeTerritoryBonus(defender.numTiles, 0.3);
  const traitorLossMod = defender.isTraitor ? 0.5 : 1;
  const traitorCostMod = defender.isTraitor ? 0.8 : 1;
  const defenderTroopLoss = defender.troops / defender.numTiles;
  const troopRatio = defender.troops / attackTroops;
  const attackerTroopLoss =
    mag *
    traitorLossMod *
    within(troopRatio, 0.6, 2) *
    (0.463 * largeAttackerBonus * largeDefenderBonus +
      0.0039 * defenderTroopLoss);
  const speedCost =
    (within(troopRatio, 0.82, 7.5) * within(troopRatio / 20, 1, 50)) / 8.55;
  const largeAttackerSpeedBonus = legacyLargeTerritoryBonus(
    attacker.numTiles,
    0.73,
  );
  return {
    attackerTroopLoss,
    defenderTroopLoss,
    tickFraction:
      (speedCost *
        tileCost *
        largeAttackerSpeedBonus *
        largeDefenderBonus *
        traitorCostMod) /
      input.borderSize,
  };
}

const TERRAINS = [
  TerrainType.Plains,
  TerrainType.Highland,
  TerrainType.Mountain,
] as const;
const TYPES = [PlayerType.Human, PlayerType.Bot, PlayerType.Nation] as const;

function randomInput(r: PseudoRandom): LegacyInput {
  const pick = <T>(xs: readonly T[]): T => xs[r.nextInt(0, xs.length)];
  const defender = r.chance(6)
    ? null
    : {
        type: pick(TYPES),
        numTiles: pick([1, 7, 500, 20_000, 150_000, 400_000, 2_000_000]),
        troops: pick([0, 1, 999, 50_000, 1_234_567, 9_000_000]),
        isTraitor: r.chance(3),
        isDisconnectedTeammate: r.chance(5),
      };
  return {
    terrain: pick(TERRAINS),
    attackTroops: pick([1, 3, 250, 10_000, 333_333, 5_000_000]),
    attacker: {
      type: pick(TYPES),
      numTiles: pick([1, 1_000, 50_000, 300_000, 1_500_000]),
    },
    defender,
    defenderHasDefensePost: r.chance(2),
    falloutRatio: r.chance(3) ? pick([0, 0.07, 0.5, 1]) : null,
    borderSize: pick([1, 2, 37, 400, 2_999]),
  };
}

describe("attackLogic moved to engine-lib", () => {
  const config = new EngineConfig({} as GameConfig, false);

  test("is bit-identical to the old EngineConfig code without siege camps", () => {
    const r = new PseudoRandom(20261104);
    for (let i = 0; i < 20_000; i++) {
      const input = randomInput(r);
      const expected = legacyAttackLogic(input);
      const actual = config.attackLogic({
        ...input,
        siegeCampReducesDefensePost: false,
      });
      expect(
        Object.is(actual.attackerTroopLoss, expected.attackerTroopLoss),
      ).toBe(true);
      expect(
        Object.is(actual.defenderTroopLoss, expected.defenderTroopLoss),
      ).toBe(true);
      expect(Object.is(actual.tickFraction, expected.tickFraction)).toBe(true);
    }
  });

  test("a siege camp swaps the post's 5x losses and 3x slowdown for 1.5x and 1.3x", () => {
    const base: AttackLogicInput = {
      terrain: TerrainType.Highland,
      attackTroops: 100_000,
      attacker: { type: PlayerType.Human, numTiles: 20_000 },
      defender: {
        type: PlayerType.Human,
        numTiles: 20_000,
        troops: 80_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: false,
      siegeCampReducesDefensePost: false,
      falloutRatio: null,
      borderSize: 50,
    };
    const open = config.attackLogic(base);
    const post = config.attackLogic({ ...base, defenderHasDefensePost: true });
    const reduced = config.attackLogic({
      ...base,
      defenderHasDefensePost: true,
      siegeCampReducesDefensePost: true,
    });
    // The flag alone (no post) changes nothing.
    expect(
      config.attackLogic({ ...base, siegeCampReducesDefensePost: true }),
    ).toEqual(open);
    expect(post.attackerTroopLoss / open.attackerTroopLoss).toBeCloseTo(5, 9);
    expect(post.tickFraction / open.tickFraction).toBeCloseTo(3, 9);
    expect(reduced.attackerTroopLoss / open.attackerTroopLoss).toBeCloseTo(
      SIEGE_CAMP_POST_DEFENSE_BONUS,
      9,
    );
    expect(reduced.tickFraction / open.tickFraction).toBeCloseTo(
      SIEGE_CAMP_POST_SPEED_BONUS,
      9,
    );
    expect(reduced.defenderTroopLoss).toBe(post.defenderTroopLoss);
  });
});

// ---------------------------------------------------------------------------
// Forecast vs the simulation
// ---------------------------------------------------------------------------

interface Check {
  input: AttackLogicInput;
  engine: AttackLogicResult;
  forecast: AttackForecast;
}

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

// plains: 100x100, all Plains. The attacker holds x < 50.
async function plainsGame(defenderTiles: boolean) {
  const game = await setup(
    "plains",
    { infiniteGold: true, instantBuild: true },
    [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("ally", PlayerType.Human, null, "ally"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  const ally = game.player("ally");
  conquerRect(game, attacker, 0, 0, 50, 90);
  conquerRect(game, ally, 0, 90, 50, 100);
  if (defenderTiles) conquerRect(game, defender, 50, 0, 100, 100);
  attacker.setTroops(200_000);
  defender.setTroops(150_000);
  return { game, attacker, defender, ally };
}

/**
 * Runs `ticks` of an attack and, for every tile the engine prices, the
 * forecast for that tile taken at the same moment, from the same troops and
 * border size.
 */
function recordAttack(
  game: Game,
  attacker: Player,
  target: Player | null,
  troops: number,
  ticks: number,
): Check[] {
  const proto = AttackExecution.prototype as unknown as {
    attackLogicInput: (...args: unknown[]) => AttackLogicInput;
  };
  const original = proto.attackLogicInput;
  const checks: Check[] = [];
  const spy = vi.spyOn(proto, "attackLogicInput").mockImplementation(function (
    this: unknown,
    ...args: unknown[]
  ) {
    const [attackTroops, tile, borderSize] = args as [number, number, number];
    const forecast = attackForecast(
      game,
      attacker,
      target,
      tile,
      attackTroops,
      borderSize - ATTACK_FRONT_JITTER_MEAN,
    );
    const input = original.apply(this, args);
    checks.push({ input, engine: game.config().attackLogic(input), forecast });
    return input;
  });
  try {
    game.addExecution(
      new AttackExecution(
        troops,
        attacker,
        target === null ? game.terraNullius().id() : target.id(),
      ),
    );
    for (let i = 0; i < ticks; i++) game.executeNextTick();
  } finally {
    spy.mockRestore();
  }
  return checks;
}

function expectForecastMatches(checks: Check[]) {
  expect(checks.length).toBeGreaterThan(20);
  for (const { input, engine, forecast } of checks) {
    expect(forecast.lossPerTile).toBe(engine.attackerTroopLoss);
    expect(forecast.tilesPerSecond).toBe(10 / engine.tickFraction);
    expect(forecast.defensePostLevel > 0).toBe(input.defenderHasDefensePost);
    expect(forecast.siegeReduced).toBe(input.siegeCampReducesDefensePost);
  }
}

describe("attack forecast matches the engine", () => {
  test("player vs player on open land", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    expect(checks.every((c) => !c.input.defenderHasDefensePost)).toBe(true);
  });

  test("into a level-2 defense post's cover", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    const post = defender.buildUnit(UnitType.DefensePost, game.ref(85, 45), {});
    post.increaseLevel();
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    // (85,45) reaches x = 50 only at level 2's 38 tiles.
    const covered = checks.filter((c) => c.input.defenderHasDefensePost);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every((c) => c.forecast.defensePostLevel === 2)).toBe(true);
    expect(checks.some((c) => !c.input.defenderHasDefensePost)).toBe(true);
  });

  test("into a post reduced by an ally's siege camp", async () => {
    const { game, attacker, defender, ally } = await plainsGame(true);
    attacker.createAllianceRequest(ally)!.accept();
    // Covers x = 50 for y 33-77, all of it on the attack front.
    defender.buildUnit(UnitType.DefensePost, game.ref(70, 55), {});
    // About 41 tiles from the post, on the ally's land.
    ally.buildUnit(UnitType.SiegeCamp, game.ref(49, 90), {});
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    const covered = checks.filter((c) => c.input.defenderHasDefensePost);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every((c) => c.input.siegeCampReducesDefensePost)).toBe(
      true,
    );
  });

  test("into unclaimed land", async () => {
    const { game, attacker } = await plainsGame(false);
    const checks = recordAttack(game, attacker, null, 60_000, 10);
    expectForecastMatches(checks);
    expect(checks.every((c) => c.input.defender === null)).toBe(true);
  });

  test("the front size is the border the attack starts with", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    const fronts = attackFrontSizes(
      game,
      attacker.borderTiles(),
      attacker.smallID(),
    );
    // x = 50 for the attacker's 90 rows; the ally holds the rest.
    expect(fronts.get(defender.smallID())).toBe(90);
    const [first] = recordAttack(game, attacker, defender, 60_000, 2);
    // AttackExecution adds 0-4 tiles of jitter to its border each tick.
    expect(first.input.borderSize).toBeGreaterThanOrEqual(90);
    expect(first.input.borderSize).toBeLessThanOrEqual(94);
  });
});
