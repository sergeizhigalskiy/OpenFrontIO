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
    /**
     * Defender is a city-state (WorldFeatures.ts): a bot that gets no
     * tribe discount. Unset counts as false.
     */
    isCityState?: boolean;
  } | null;
  /** A defense post owned by the defender is in range of the tile. */
  defenderHasDefensePost: boolean;
  /** Fraction of land tiles with fallout, or null if the tile has no fallout. */
  falloutRatio: number | null;
  /**
   * Tiles on the attack front this tick (plus jitter), capped for a
   * spearhead (attackBudgetFront); fixed for the tick.
   */
  borderSize: number;
  /**
   * A spearhead tile's depth from the spear's origin (spearDepth), which
   * prices its supply line (spearOverextension) when a human or a nation
   * defends it. Unset or 0 for a broad attack.
   */
  spearDepth?: number;
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
// Tribes only: a city-state defends at the full rate.
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
 * A spearhead (an attack with a focus tile) spends the tick budget of at most
 * this many front tiles, however long its whole front is. A broad attack
 * spends its whole front's.
 */
export const SPEAR_BUDGET_FRONT = 48;

/**
 * The front size an attack's tick budget comes from: its border, capped at
 * SPEAR_BUDGET_FRONT for a spearhead. AttackExecution and the forecast both
 * use it, before adding the tick's jitter.
 */
export function attackBudgetFront(
  borderSize: number,
  spearhead: boolean,
): number {
  return spearhead ? Math.min(borderSize, SPEAR_BUDGET_FRONT) : borderSize;
}

/**
 * Supply lines: a spearhead tile deeper than this many tiles from the
 * spear's origin costs more troops and time, by spearOverextension.
 */
export const SPEAR_FREE_DEPTH = 20;
/** ...one more 1x of both per this many tiles past SPEAR_FREE_DEPTH... */
export const SPEAR_OVEREXTEND_SCALE = 9;
/** ...up to this multiple. */
export const SPEAR_OVEREXTEND_MAX = 3.25;
/**
 * A spear's origin is the attacker's tile nearest the focus when its first
 * spearhead on a target starts. Until this many ticks (60 s) after the last
 * one ran, a spearhead on that target that merges into a running one, or
 * starts within SPEAR_FREE_DEPTH of the deepest tile they took, keeps it, so
 * relaunching from the tip doesn't reset the depth (Player.startSpear).
 */
export const SPEAR_ORIGIN_MEMORY_TICKS = 600;

/**
 * The origin a spearhead counts depth from when it starts with `natural` as
 * the attacker's tile nearest its focus: the remembered `line`'s origin if it
 * merges into a running spearhead on the target or starts within
 * SPEAR_FREE_DEPTH of the line's tip (relaunching from the spear), else
 * `natural`. `distance` is the map's manhattan distance.
 */
export function spearOriginFor(
  natural: number,
  line: { origin: number; tip: number } | null,
  running: boolean,
  distance: (a: number, b: number) => number,
): number {
  if (line === null) return natural;
  if (running || distance(natural, line.tip) <= SPEAR_FREE_DEPTH) {
    return line.origin;
  }
  return natural;
}

/**
 * What a spearhead tile `depth` tiles from the spear's origin multiplies its
 * troop loss and capture time by: 1 up to SPEAR_FREE_DEPTH, then rising by 1
 * per SPEAR_OVEREXTEND_SCALE tiles, capped at SPEAR_OVEREXTEND_MAX. A broad
 * attack has no depth and pays 1x.
 */
export function spearOverextension(depth: number): number {
  return Math.min(
    SPEAR_OVEREXTEND_MAX,
    1 + Math.max(0, depth - SPEAR_FREE_DEPTH) / SPEAR_OVEREXTEND_SCALE,
  );
}

/**
 * How deep tile (tx, ty) lies on a spear from origin (ox, oy) toward its
 * focus (fx, fy): its manhattan distance from the origin measured along the
 * line to the focus. A tile on that line, the focus itself included, is
 * exactly its manhattan distance from the origin; a flank tile beside the
 * attacker's own border, off to the side of the line, is near 0 however far
 * along the border it lies; a tile behind the origin is 0. Exact arithmetic
 * on whole tiles, so every client gets the same number.
 */
export function spearDepth(
  ox: number,
  oy: number,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
): number {
  const ux = fx - ox;
  const uy = fy - oy;
  const l1 = Math.abs(ux) + Math.abs(uy);
  if (l1 === 0) return Math.abs(tx - ox) + Math.abs(ty - oy);
  const along = (tx - ox) * ux + (ty - oy) * uy;
  if (along <= 0) return 0;
  return (along * l1) / (ux * ux + uy * uy);
}

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
 *
 * A spearhead tile on a human's or a nation's land past SPEAR_FREE_DEPTH
 * from the spear's origin multiplies both its loss and its time by
 * spearOverextension; free land, tribes and city-states never do.
 */
export function attackLogic(
  input: AttackLogicInput,
  rules: AttackRules,
): AttackLogicResult {
  const { attackTroops, attacker, defender } = input;
  let { mag, tileCost } = terrainAttackBase(input.terrain);

  if (defender !== null && input.defenderHasDefensePost) {
    mag *= rules.defensePostDefenseBonus();
    tileCost *= rules.defensePostSpeedBonus();
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
    defender.type === PlayerType.Bot &&
    defender.isCityState !== true
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
  // Supply lines: a deep spearhead tile costs more of both, on a human's
  // or a nation's land (tribes and city-states have none to cut).
  const overextension =
    defender.type === PlayerType.Bot
      ? 1
      : spearOverextension(input.spearDepth ?? 0);
  return {
    attackerTroopLoss: attackerTroopLoss * overextension,
    defenderTroopLoss,
    tickFraction:
      (speedCost *
        tileCost *
        largeAttackerSpeedBonus *
        largeDefenderBonus *
        traitorCostMod *
        overextension) /
      input.borderSize,
  };
}
