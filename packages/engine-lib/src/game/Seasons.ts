import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";

/**
 * Seasons: every SEASON_CYCLE_TICKS a WINTER_TICKS winter arrives, announced
 * WINTER_WARNING_TICKS ahead. The first winter starts one full cycle after
 * the spawn phase ends. During winter, attacks into snow land take
 * WINTER_ATTACK_TIME_MULTIPLIER times as long, with no extra losses (one of
 * the environment factors capped together in AttackEnvironment.ts), and every
 * player's troops grow at WINTER_TROOP_GROWTH_MULTIPLIER of the usual rate.
 *
 * A pure function of the ticks since the spawn phase ended, so it needs no
 * state and the engine and the client HUD read the same clock. Off when the
 * game config turns it off (Config.seasonsEnabled).
 */

/** Ticks from one winter's start to the next: 7 minutes. */
export const SEASON_CYCLE_TICKS = 7 * 60 * 10;
/** How long a winter lasts: 90 seconds. */
export const WINTER_TICKS = 90 * 10;
/** How long before a winter its warning shows: 30 seconds. */
export const WINTER_WARNING_TICKS = 30 * 10;
/** Capture time on snow land during winter (+25%). Losses are unchanged. */
export const WINTER_ATTACK_TIME_MULTIPLIER = 1.25;
/** Troop growth during winter, for every player. */
export const WINTER_TROOP_GROWTH_MULTIPLIER = 0.9;
/** Land in this northernmost share of the map (by tile y) is snow land. */
export const SNOW_NORTH_PERCENT = 25;

export enum SeasonPhase {
  /** No winter, none due within the warning window. */
  Fair = "fair",
  /** Winter starts within WINTER_WARNING_TICKS. */
  Warning = "warning",
  Winter = "winter",
}

export interface SeasonState {
  phase: SeasonPhase;
  /** Ticks until this phase ends (Fair → Warning → Winter → Fair). */
  ticksLeft: number;
  /** 1 for the first winter; during Fair and Warning, the next one. */
  winter: number;
}

/**
 * The season `ticksSinceStart` ticks after the spawn phase ended (0 during
 * the spawn phase). Winter k (k >= 1) covers
 * [k * SEASON_CYCLE_TICKS, k * SEASON_CYCLE_TICKS + WINTER_TICKS).
 */
export function seasonAt(ticksSinceStart: number): SeasonState {
  const t = Math.max(0, Math.floor(ticksSinceStart));
  const k = Math.floor(t / SEASON_CYCLE_TICKS);
  const pos = t - k * SEASON_CYCLE_TICKS;
  if (k >= 1 && pos < WINTER_TICKS) {
    return {
      phase: SeasonPhase.Winter,
      ticksLeft: WINTER_TICKS - pos,
      winter: k,
    };
  }
  const warningAt = SEASON_CYCLE_TICKS - WINTER_WARNING_TICKS;
  if (pos >= warningAt) {
    return {
      phase: SeasonPhase.Warning,
      ticksLeft: SEASON_CYCLE_TICKS - pos,
      winter: k + 1,
    };
  }
  return { phase: SeasonPhase.Fair, ticksLeft: warningAt - pos, winter: k + 1 };
}

export function isWinterAt(ticksSinceStart: number): boolean {
  return seasonAt(ticksSinceStart).phase === SeasonPhase.Winter;
}

/**
 * Snow land: any passable land tile (plains, highland or mountain) in the
 * northernmost SNOW_NORTH_PERCENT of the map by tile y. Water and impassable
 * terrain never are. (The client's winter tint shader encodes the same rule
 * on the terrain bytes: see WeatherPass.)
 */
export function isSnowLand(map: GameMap, tile: TileRef): boolean {
  return (
    map.isLand(tile) &&
    !map.isImpassable(tile) &&
    map.y(tile) * 100 < map.height() * SNOW_NORTH_PERCENT
  );
}

/** Whether winter slows an attack into `tile`: it is winter and snow land. */
export function winterSlowsAttack(
  winter: boolean,
  map: GameMap,
  tile: TileRef,
): boolean {
  return winter && isSnowLand(map, tile);
}

/** Troop growth multiplier. */
export function seasonTroopGrowthMultiplier(winter: boolean): number {
  return winter ? WINTER_TROOP_GROWTH_MULTIPLIER : 1;
}
