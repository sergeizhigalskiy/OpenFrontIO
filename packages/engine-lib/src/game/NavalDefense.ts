/**
 * Naval defense rules: minefields and coastal batteries.
 *
 * Shared by the engine (placement, cost, combat) and the client (build menu
 * cost, placement preview), so every tunable number lives here. All math is
 * integer, so the engine stays deterministic.
 */
import {
  Gold,
  MINEFIELD_DEFAULT_DENSITY,
  MINEFIELD_MAX_DENSITY,
  MINEFIELD_MIN_DENSITY,
} from "@openfront/engine-api/game/GameTypes";

export {
  MINEFIELD_DEFAULT_DENSITY,
  MINEFIELD_MAX_DENSITY,
  MINEFIELD_MIN_DENSITY,
};

// ---------------------------------------------------------------------------
// Minefield
// ---------------------------------------------------------------------------

/**
 * Radius in tiles of the circle a minefield covers around its center tile:
 * wide enough that a few fields wall off a stretch of coast against landings.
 */
export const MINEFIELD_RADIUS = 30;

/**
 * A minefield's center must be an ocean tile at most this many tiles
 * (euclidean) from a tile the player owns.
 */
export const MINEFIELD_PLACEMENT_RANGE = 25;

/** Price of a player's first minefield at full (100%) density. */
export const MINEFIELD_BASE_COST = 120_000;

/** Each minefield already owned raises the price by this percent of the base. */
export const MINEFIELD_COST_INCREASE_PER_FIELD_PERCENT = 50;

/** The price stops rising at this percent of the first field's price (3x). */
export const MINEFIELD_MAX_COST_PERCENT = 300;

/**
 * Chance, in basis points (1/100 of a percent), that a hostile ship is hit for
 * each new tile it enters inside a full-density field: 700 = 7%. It scales
 * linearly with density, so a 25% field hits 1.75% of the time per tile.
 */
export const MINEFIELD_HIT_CHANCE_BASIS_POINTS = 700;

/** A mine hit takes this percent of a warship's max health. */
export const MINEFIELD_WARSHIP_DAMAGE_PERCENT = 40;

/** Density points a field loses for every hit; at 0 it is gone. */
export const MINEFIELD_DEPLETION_PER_HIT = 15;

/** Clamps a requested density to a valid integer percent. */
export function clampMinefieldDensity(density: number): number {
  if (!Number.isFinite(density)) return MINEFIELD_DEFAULT_DENSITY;
  return Math.min(
    MINEFIELD_MAX_DENSITY,
    Math.max(MINEFIELD_MIN_DENSITY, Math.floor(density)),
  );
}

/**
 * Price of a minefield of `density` percent for a player who already owns
 * `fieldsOwned` fields:
 * `MINEFIELD_BASE_COST × density/100 × min(3, 1 + 0.5 × fieldsOwned)`.
 */
export function minefieldCost(density: number, fieldsOwned: number): number {
  const multiplierPercent = Math.min(
    MINEFIELD_MAX_COST_PERCENT,
    100 + MINEFIELD_COST_INCREASE_PER_FIELD_PERCENT * Math.max(0, fieldsOwned),
  );
  return Math.floor(
    (MINEFIELD_BASE_COST * clampMinefieldDensity(density) * multiplierPercent) /
      (100 * 100),
  );
}

/**
 * The price at `density` given the price at the default density, which is
 * what the engine reports for the build menu. Exact, since the price is
 * linear in density.
 */
export function minefieldCostAtDensity(
  defaultDensityCost: Gold,
  density: number,
): Gold {
  return (
    (defaultDensityCost * BigInt(clampMinefieldDensity(density))) /
    BigInt(MINEFIELD_DEFAULT_DENSITY)
  );
}

/** Per-tile hit chance in basis points for a field of `density` percent. */
export function minefieldHitChanceBasisPoints(density: number): number {
  return Math.floor((MINEFIELD_HIT_CHANCE_BASIS_POINTS * density) / 100);
}

// ---------------------------------------------------------------------------
// Coastal battery
// ---------------------------------------------------------------------------

/** A battery's max health as a percent of a warship's max health. */
export const COASTAL_BATTERY_HEALTH_PERCENT_OF_WARSHIP = 150;

/**
 * Tiles (euclidean) within which a battery shells hostile ships: past a
 * warship's targeting range (130), so a warship can't shell a battery from
 * where the battery can't answer.
 */
export const COASTAL_BATTERY_RANGE = 140;

/**
 * Ticks between two shells from one battery: faster than a warship (20), so
 * one battery beats one warship and two warships are about an even fight.
 */
export const COASTAL_BATTERY_RELOAD_TICKS = 15;

/** Price of the first battery; each one owned adds this much again. */
export const COASTAL_BATTERY_BASE_COST = 150_000;

/** Batteries never cost more than this. */
export const COASTAL_BATTERY_MAX_COST = 600_000;

/** Build time in ticks, the same as a defense post. */
export const COASTAL_BATTERY_CONSTRUCTION_TICKS = 50;

/** Price of a battery for a player who already owns `owned` of them. */
export function coastalBatteryCost(owned: number): number {
  return Math.min(
    COASTAL_BATTERY_MAX_COST,
    (Math.max(0, owned) + 1) * COASTAL_BATTERY_BASE_COST,
  );
}
