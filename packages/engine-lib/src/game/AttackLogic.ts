/**
 * The per-tile attack math: what a tile costs the attacker in troops and how
 * much of a tick's conquest budget it takes.
 *
 * Pure: it depends only on its input and a few rule tunables, never on game
 * objects. The engine runs it for every conquered tile (AttackExecution,
 * through Config.attackLogic) and the client runs the same function for the
 * attack forecast in the hover card, so the forecast is the engine's number.
 */
import { PlayerType, TerrainType } from "@openfront/engine-api/game/GameTypes";
import { log } from "../DetMath";
import { sigmoid, within } from "../Util";
import {
  SIEGE_CAMP_POST_DEFENSE_BONUS,
  SIEGE_CAMP_POST_SPEED_BONUS,
} from "./Siege";

export interface AttackLogicInput {
  terrain: TerrainType;
  attackTroops: number;
  attacker: { type: PlayerType; numTiles: number };
  /** null when attacking terra nullius. */
  defender: {
    type: PlayerType;
    numTiles: number;
    troops: number;
    isTraitor: boolean;
    /** Defender is disconnected and on the attacker's team. */
    isDisconnectedTeammate: boolean;
  } | null;
  /** A defense post owned by the defender is in range of the tile. */
  defenderHasDefensePost: boolean;
  /**
   * Every defense post covering the tile has a siege camp of the attacker or
   * a friend of theirs in range (see Siege.ts), so the posts give the reduced
   * bonus. Only read when defenderHasDefensePost.
   */
  siegeCampReducesDefensePost: boolean;
  /** Fraction of land tiles with fallout, or null if the tile has no fallout. */
  falloutRatio: number | null;
  /** Tiles on the attack front this tick (plus jitter); fixed for the tick. */
  borderSize: number;
  // weather-seasons hooks (Seasons.ts, Weather.ts): 1 when absent.
  /** Scales the attacker's troop loss (winter on snow land). */
  weatherLossMultiplier?: number;
  /** Scales the tile's tick cost (a mud front on enemy land). */
  weatherTileCostMultiplier?: number;
}

export interface AttackLogicResult {
  attackerTroopLoss: number;
  defenderTroopLoss: number;
  /**
   * Share of this tick's conquest budget the tile consumes. An attack keeps
   * conquering tiles until the fractions sum to 1, so a tile costing 0.1
   * means about ten such tiles per tick.
   */
  tickFraction: number;
}

/** The rule tunables attackLogic reads; Config implements them. */
export interface AttackRules {
  defensePostDefenseBonus(): number;
  defensePostSpeedBonus(): number;
  falloutDefenseModifier(falloutRatio: number): number;
  traitorDefenseDebuff(): number;
  traitorSpeedDebuff(): number;
}

// attackLogic tunables
const LARGE_TERRITORY_MIDPOINT = 300_000;
const LARGE_TERRITORY_STEEPNESS = 2.5;
// Floors: a huge attacker's bonus bottoms at 0.3x (losses; speed uses the
// deeper LARGE_ATTACKER_SPEED_DEPTH below), a huge defender's at 0.7x.
const LARGE_ATTACKER_DEPTH = 0.7;
const LARGE_DEFENDER_DEPTH = 0.3;
const BOT_DEFENDER_LOSS_MULT = 0.7;
const TERRA_NULLIUS_COST_SCALE = 2000;
const TERRA_NULLIUS_MIN_COST = 5;
const TERRA_NULLIUS_MAX_COST = 100;
// Attacker loss = mag * clampedRatio * (BASE * largeAttackerBonus + DENSITY * troopsPerTile).
// BASE is the old 0.48 ratio weight times the 0.965 large-defender sigmoid
// tail that every defender used to get. DENSITY sets which stack size pays
// the old 0.0052 density weight: at 0.0039 a stack of 3/4 the defender's
// army matches the old cost, bigger stacks pay less, smaller pay more.
const ATTACKER_LOSS_BASE = 0.463;
/** Defender troops per attacking troop at or below which the attacker's losses stop shrinking */
export const CHEAPEST_TROOP_RATIO = 0.6;
const ATTACKER_LOSS_PER_DENSITY = 0.0039;
// Speed divisor: 8.25 / 0.965, absorbing the same sigmoid tail. 8.25 is the
// old 7.5 raised ~10%: v34 pace feedback said attacks felt a bit too slow, so
// every player-vs-player attack lands ~10% faster across the board.
const SPEED_COST_DIVISOR = 8.55;
// Speed-only: the attacker's territory bonus runs a touch deeper for speed
// than the 0.7 loss depth above (floor 0.27x vs 0.3x). Paired with the 0.82
// sub-parity floor on the ratio curve, an overwhelming push lands ~18%
// faster for a small attacker, ~20% at the 300k midpoint, ~25% for giants.
const LARGE_ATTACKER_SPEED_DEPTH = 0.73;

/**
 * Logistic in log(tiles): ~1 for small territories, easing down to
 * 1 - depth for huge ones, halfway at LARGE_TERRITORY_MIDPOINT.
 */
export function largeTerritoryBonus(numTiles: number, depth: number): number {
  return (
    1 -
    depth *
      sigmoid(
        log(numTiles),
        LARGE_TERRITORY_STEEPNESS,
        log(LARGE_TERRITORY_MIDPOINT),
      )
  );
}

export function terrainAttackBase(terrain: TerrainType): {
  mag: number;
  tileCost: number;
} {
  switch (terrain) {
    case TerrainType.Plains:
      return { mag: 80, tileCost: 16.5 };
    case TerrainType.Highland:
      return { mag: 100, tileCost: 20 };
    case TerrainType.Mountain:
      return { mag: 120, tileCost: 25 };
    case TerrainType.Impassable:
      throw new Error(`impassable terrain cannot be attacked`);
    default:
      throw new Error(`terrain type ${terrain} not supported`);
  }
}

/**
 * Per-tile attack outcome.
 *
 * Two base values come from the terrain and are scaled by the situation:
 *  - `mag`: how bloody the tile is (drives attacker troop loss)
 *  - `tileCost`: how expensive the tile is to take (higher = slower)
 *
 * Speed: each tick the attack can take about `borderSize` tiles worth of
 * budget; each tile consumes `tileCost`, scaled by how outnumbered the
 * attack is. The result reports that as a fraction of the tick.
 */
export function attackLogic(
  input: AttackLogicInput,
  rules: AttackRules,
): AttackLogicResult {
  const { attackTroops, attacker, defender } = input;
  let { mag, tileCost } = terrainAttackBase(input.terrain);
  // weather-seasons hook: winter and mud (see AttackLogicInput).
  mag *= input.weatherLossMultiplier ?? 1;
  tileCost *= input.weatherTileCostMultiplier ?? 1;

  if (defender !== null && input.defenderHasDefensePost) {
    if (input.siegeCampReducesDefensePost) {
      mag *= SIEGE_CAMP_POST_DEFENSE_BONUS;
      tileCost *= SIEGE_CAMP_POST_SPEED_BONUS;
    } else {
      mag *= rules.defensePostDefenseBonus();
      tileCost *= rules.defensePostSpeedBonus();
    }
  }
  if (input.falloutRatio !== null) {
    const fallout = rules.falloutDefenseModifier(input.falloutRatio);
    mag *= fallout;
    tileCost *= fallout;
  }

  if (defender === null) {
    const tickBudget = input.borderSize * 2;
    return {
      attackerTroopLoss: mag / (attacker.type === PlayerType.Bot ? 10 : 5),
      defenderTroopLoss: 0,
      tickFraction:
        within(
          (TERRA_NULLIUS_COST_SCALE * tileCost) / attackTroops,
          TERRA_NULLIUS_MIN_COST,
          TERRA_NULLIUS_MAX_COST,
        ) / tickBudget,
    };
  }

  if (defender.isDisconnectedTeammate) {
    // No troop loss if defender is disconnected and on same team
    mag = 0;
  }
  if (
    (attacker.type === PlayerType.Human ||
      attacker.type === PlayerType.Nation) &&
    defender.type === PlayerType.Bot
  ) {
    mag *= BOT_DEFENDER_LOSS_MULT;
  }

  // Big territories are cheaper and faster to attack from and into, so
  // late games stay dynamic. The attacker's bonus is the stronger one.
  const largeAttackerBonus = largeTerritoryBonus(
    attacker.numTiles,
    LARGE_ATTACKER_DEPTH,
  );
  const largeDefenderBonus = largeTerritoryBonus(
    defender.numTiles,
    LARGE_DEFENDER_DEPTH,
  );

  const traitorLossMod = defender.isTraitor ? rules.traitorDefenseDebuff() : 1;
  const traitorCostMod = defender.isTraitor ? rules.traitorSpeedDebuff() : 1;

  // Defender loses its average troops-per-tile.
  const defenderTroopLoss = defender.troops / defender.numTiles;

  // Two ratios drive the attacker's loss: how outnumbered the attack is
  // (defender army / attack stack, clamped: bigger pushes pay less per
  // tile) scales a cost made of a base plus the defender's troop density
  // (packed land is expensive, spread-thin land is cheap).
  const troopRatio = defender.troops / attackTroops;
  const attackerTroopLoss =
    mag *
    traitorLossMod *
    within(troopRatio, CHEAPEST_TROOP_RATIO, 2) *
    (ATTACKER_LOSS_BASE * largeAttackerBonus * largeDefenderBonus +
      ATTACKER_LOSS_PER_DENSITY * defenderTroopLoss);

  // Speed: a tile's cost in tick-fractions grows with how outnumbered the
  // attack is. Floored at 0.82 below parity (overwhelming stacks land ~18%
  // faster), then rising linearly (saturating at 7.5x), with a second ramp
  // for hopeless attacks past 20x.
  const speedCost =
    (within(troopRatio, 0.82, 7.5) * within(troopRatio / 20, 1, 50)) /
    SPEED_COST_DIVISOR;
  const largeAttackerSpeedBonus = largeTerritoryBonus(
    attacker.numTiles,
    LARGE_ATTACKER_SPEED_DEPTH,
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
