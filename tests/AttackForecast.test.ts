/**
 * The attack math moved from EngineConfig to engine-lib (AttackLogic.ts) so
 * the client's attack forecast can run it. These tests pin that:
 *  - the moved attackLogic is bit-identical to the old EngineConfig code
 *    (a verbatim copy lives below) over a wide spread of inputs;
 *  - the forecast the hover card shows is exactly what AttackExecution
 *    computes for the same tile: defense posts, the capped environment
 *    (forest, river, ford, winter, mud) and a spearhead's budget cap;
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
  attackEnvironment,
  ENVIRONMENT_TIME_CAP,
  withEnvironmentCost,
} from "@openfront/engine-lib/game/AttackEnvironment";
import {
  ATTACK_FRONT_JITTER_MEAN,
  AttackForecast,
  attackForecast,
  attackFrontSizes,
} from "@openfront/engine-lib/game/AttackForecast";
import {
  AttackLogicInput,
  AttackLogicResult,
  SPEAR_BUDGET_FRONT,
} from "@openfront/engine-lib/game/AttackLogic";
import {
  SEASON_CYCLE_TICKS,
  WINTER_ATTACK_TIME_MULTIPLIER,
} from "@openfront/engine-lib/game/Seasons";
import {
  FOREST_DEFENDED_LOSS_MULTIPLIER,
  FOREST_TIME_MULTIPLIER,
  TerrainFeature,
} from "@openfront/engine-lib/game/TerrainFeatures";
import { MUD_TILE_COST_MULTIPLIER } from "@openfront/engine-lib/game/Weather";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { sigmoid, within } from "@openfront/engine-lib/Util";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { CALM, WeatherSystem } from "@openfront/engine/game/WeatherSystem";
import { vi } from "vitest";
import { setup } from "./util/Setup";
import { UseRealAttackLogic } from "./util/TestConfig";

// ---------------------------------------------------------------------------
// The pre-move EngineConfig.attackLogic, verbatim (tunables inlined).
// ---------------------------------------------------------------------------

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

function legacyAttackLogic(input: AttackLogicInput): AttackLogicResult {
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

function randomInput(r: PseudoRandom): AttackLogicInput {
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

  test("is bit-identical to the old EngineConfig code", () => {
    const r = new PseudoRandom(20261104);
    for (let i = 0; i < 20_000; i++) {
      const input = randomInput(r);
      const expected = legacyAttackLogic(input);
      const actual = config.attackLogic(input);
      expect(
        Object.is(actual.attackerTroopLoss, expected.attackerTroopLoss),
      ).toBe(true);
      expect(
        Object.is(actual.defenderTroopLoss, expected.defenderTroopLoss),
      ).toBe(true);
      expect(Object.is(actual.tickFraction, expected.tickFraction)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Forecast vs the simulation
// ---------------------------------------------------------------------------

interface Check {
  input: AttackLogicInput;
  tile: number;
  /** What AttackExecution charges: attackLogic, then the environment. */
  engine: AttackLogicResult;
  forecast: AttackForecast;
  /** The front the forecast was given. */
  front: number;
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
 * border size. With `focus` the attack is a spearhead at that tile.
 */
function recordAttack(
  game: Game,
  attacker: Player,
  target: Player | null,
  troops: number,
  ticks: number,
  focus: number | null = null,
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
    // A broad attack's front is its border; a spearhead's forecast is
    // given the whole border and caps it itself.
    const front =
      focus === null
        ? borderSize - ATTACK_FRONT_JITTER_MEAN
        : (this as { attack: { borderSize(): number } }).attack.borderSize();
    const forecast = attackForecast(
      game,
      attacker,
      target,
      tile,
      attackTroops,
      front,
      focus !== null,
    );
    const input = original.apply(this, args);
    const engine = withEnvironmentCost(
      game.config().attackLogic(input),
      attackEnvironment(
        game,
        tile,
        target !== null,
        input.defenderHasDefensePost,
      ),
    );
    checks.push({ input, tile, engine, forecast, front });
    return input;
  });
  try {
    game.addExecution(
      new AttackExecution(
        troops,
        attacker,
        target === null ? game.terraNullius().id() : target.id(),
        null,
        true,
        focus,
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
  for (const { engine, forecast } of checks) {
    expect(forecast.lossPerTile).toBe(engine.attackerTroopLoss);
    expect(forecast.tilesPerSecond).toBe(10 / engine.tickFraction);
  }
}

describe("attack forecast matches the engine", () => {
  test("player vs player on open land", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    expect(checks.every((c) => !c.input.defenderHasDefensePost)).toBe(true);
  });

  test("into a defense post's cover", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    // 28 tiles from the front at y = 45: it covers part of the front.
    defender.buildUnit(UnitType.DefensePost, game.ref(78, 45), {});
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    const covered = checks.filter((c) => c.input.defenderHasDefensePost);
    expect(covered.length).toBeGreaterThan(0);
    expect(checks.some((c) => !c.input.defenderHasDefensePost)).toBe(true);
  });

  test("in winter and mud, with the same multipliers as the attack", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    // Winter on the seasons' clock (its first winter starts a cycle in).
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(SEASON_CYCLE_TICKS + 5);
    expect(game.config().isWinter(game.ticksSinceStart())).toBe(true);
    // A mud front over the defender's land south of y = 50.
    const mud: WeatherSystem = {
      cells: () => [],
      attackTileCostMultiplier: (tile) =>
        game.y(tile) >= 50 ? MUD_TILE_COST_MULTIPLIER : 1,
      inStorm: () => false,
      stormMove: () => CALM,
    };
    game.setWeather(mud);
    const checks = recordAttack(game, attacker, defender, 60_000, 20);
    expectForecastMatches(checks);
    // Snow is the northern 25% of the plains: both sides of each rule show up.
    const envs = checks.map((c) =>
      attackEnvironment(game, c.tile, true, c.input.defenderHasDefensePost),
    );
    expect(new Set(envs.map((e) => e.winterSnow))).toEqual(
      new Set([true, false]),
    );
    expect(new Set(envs.map((e) => e.mud))).toEqual(new Set([true, false]));
    // Winter and mud slow the attack and cost no extra troops.
    const both = checks.find((_, i) => envs[i].winterSnow && envs[i].mud);
    const bare = (c: Check) => game.config().attackLogic(c.input);
    if (both !== undefined) {
      expect(both.forecast.lossPerTile).toBe(bare(both).attackerTroopLoss);
      expect(10 / both.forecast.tilesPerSecond!).toBeCloseTo(
        bare(both).tickFraction *
          Math.min(
            WINTER_ATTACK_TIME_MULTIPLIER * MUD_TILE_COST_MULTIPLIER,
            ENVIRONMENT_TIME_CAP,
          ),
        9,
      );
    }
  });

  test("over forest, river and ford, stacked with winter", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(SEASON_CYCLE_TICKS + 5);
    // Columns of forest, river and ford on the defender's side of x = 50.
    const feature = (tile: number): TerrainFeature => {
      const x = game.x(tile);
      if (x === 50 || x === 51) return TerrainFeature.Forest;
      if (x === 52)
        return game.y(tile) % 10 === 0
          ? TerrainFeature.Ford
          : TerrainFeature.River;
      return TerrainFeature.None;
    };
    // The map reads it for the engine and, through the game, for the forecast.
    vi.spyOn(game.map(), "terrainFeature").mockImplementation(feature);
    const checks = recordAttack(game, attacker, defender, 60_000, 30);
    expectForecastMatches(checks);
    const by = (f: TerrainFeature) =>
      checks.filter((c) => feature(c.tile) === f);
    expect(by(TerrainFeature.Forest).length).toBeGreaterThan(0);
    expect(by(TerrainFeature.River).length).toBeGreaterThan(0);
    const snow = (c: Check) => game.y(c.tile) < 25;
    // On snow, the forest's 1.2x loss alone (winter adds none), and its 1.2x
    // time times winter's 1.25x.
    const snowForest = by(TerrainFeature.Forest).find(snow)!;
    const bare = game.config().attackLogic(snowForest.input);
    expect(snowForest.forecast.lossPerTile).toBeCloseTo(
      bare.attackerTroopLoss * FOREST_DEFENDED_LOSS_MULTIPLIER,
      9,
    );
    expect(10 / snowForest.forecast.tilesPerSecond!).toBeCloseTo(
      bare.tickFraction *
        FOREST_TIME_MULTIPLIER *
        WINTER_ATTACK_TIME_MULTIPLIER,
      9,
    );
    // A river in winter: 2.0x times 1.25x, capped at 2.0x.
    const river = by(TerrainFeature.River).find(snow)!;
    expect(10 / river.forecast.tilesPerSecond!).toBeCloseTo(
      game.config().attackLogic(river.input).tickFraction *
        ENVIRONMENT_TIME_CAP,
      9,
    );
  });

  test("a spearhead, priced with its capped budget", async () => {
    const { game, attacker, defender } = await plainsGame(true);
    // A post in the way, so the cover and the cap both show up.
    defender.buildUnit(UnitType.DefensePost, game.ref(80, 45), {});
    const checks = recordAttack(
      game,
      attacker,
      defender,
      60_000,
      20,
      game.ref(85, 45),
    );
    expect(checks.length).toBeGreaterThan(20);
    for (const c of checks) {
      // The engine's front is the border capped at 48 tiles, plus 0-4 tiles
      // of jitter; the forecast prices the cap plus the mean jitter.
      const capped = Math.min(c.front, SPEAR_BUDGET_FRONT);
      expect(c.input.borderSize).toBeGreaterThanOrEqual(capped);
      expect(c.input.borderSize).toBeLessThanOrEqual(capped + 4);
      expect(c.forecast.lossPerTile).toBe(c.engine.attackerTroopLoss);
      const priced = withEnvironmentCost(
        game.config().attackLogic({
          ...c.input,
          borderSize: capped + ATTACK_FRONT_JITTER_MEAN,
        }),
        attackEnvironment(game, c.tile, true, c.input.defenderHasDefensePost),
      );
      expect(c.forecast.tilesPerSecond).toBe(10 / priced.tickFraction);
    }
    // The border outgrew the cap.
    expect(checks.some((c) => c.front > SPEAR_BUDGET_FRONT)).toBe(true);
    expect(checks.some((c) => c.input.defenderHasDefensePost)).toBe(true);
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
    // A spearhead's budget front stops at 48 tiles.
    const spear = await plainsGame(true);
    const [tip] = recordAttack(
      spear.game,
      spear.attacker,
      spear.defender,
      60_000,
      2,
      spear.game.ref(80, 45),
    );
    expect(tip.input.borderSize).toBeGreaterThanOrEqual(SPEAR_BUDGET_FRONT);
    expect(tip.input.borderSize).toBeLessThanOrEqual(SPEAR_BUDGET_FRONT + 4);
  });
});
