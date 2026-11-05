/**
 * Reload state of the units that fire rounds and reload them.
 *
 * Each of them keeps its reload on the unit's missile timer queue: the tick
 * each round was fired (or, for a silo or SAM upgrade, the tick the new slot
 * was added), oldest first. A round is loaded again `reloadTicks` after its
 * timer, and the timers run side by side. Pure, so the reload bars
 * (ReloadBarPass) and the hover card read the same numbers.
 */

import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRBASE_SORTIE_RECHARGE_TICKS,
  FLAK_GUN_RELOAD_TICKS,
  FLAK_ROUNDS,
} from "@openfront/engine-lib/game/ConventionalWar";
import { COASTAL_BATTERY_RELOAD_TICKS } from "@openfront/engine-lib/game/NavalDefense";

/** How many rounds a unit holds and how long one takes to reload. */
export interface ReloadSpec {
  rounds: number;
  reloadTicks: number;
}

/** The part of the rules config the reload times come from. */
export interface ReloadConfig {
  SAMCooldown(): number;
  SiloCooldown(): number;
}

/**
 * The rounds and reload time of a unit type, or null for one that doesn't
 * reload. Mirrors the executions that empty each queue: SAMLauncherExecution,
 * MissileSiloExecution, FlakGunExecution, AirbaseExecution and
 * CoastalBatteryExecution.
 */
export function reloadSpec(
  unitType: string,
  level: number,
  config: ReloadConfig,
): ReloadSpec | null {
  switch (unitType) {
    case UnitType.SAMLauncher:
      return { rounds: level, reloadTicks: config.SAMCooldown() };
    case UnitType.MissileSilo:
      // Its missiles: nukes, or cruise, ballistic and cluster missiles.
      return { rounds: level, reloadTicks: config.SiloCooldown() };
    case UnitType.FlakGun:
      return { rounds: FLAK_ROUNDS, reloadTicks: FLAK_GUN_RELOAD_TICKS };
    case UnitType.Airbase:
      // Its airstrike or airdrop sortie. Drones don't use it.
      return { rounds: level, reloadTicks: AIRBASE_SORTIE_RECHARGE_TICKS };
    case UnitType.CoastalBattery:
      return { rounds: 1, reloadTicks: COASTAL_BATTERY_RELOAD_TICKS };
    default:
      return null;
  }
}

export interface ReloadState {
  rounds: number;
  /** Rounds loaded and ready to fire. */
  ready: number;
  /** How full each reloading round is (0-1), fullest first. */
  reloading: number[];
  /** Ticks until the next round is loaded; 0 when every round is ready. */
  nextReadyTicks: number;
}

/** A unit's rounds at `tick`, from its missile timer queue. */
export function reloadState(
  timers: readonly number[],
  spec: ReloadSpec,
  tick: number,
): ReloadState {
  const rounds = Math.max(0, Math.floor(spec.rounds));
  const count = Math.min(timers.length, rounds);
  const reloading: number[] = [];
  let longest = -Infinity;
  for (let i = 0; i < count; i++) {
    const elapsed = tick - timers[i];
    longest = Math.max(longest, elapsed);
    reloading.push(
      spec.reloadTicks > 0
        ? Math.min(1, Math.max(0, elapsed / spec.reloadTicks))
        : 1,
    );
  }
  reloading.sort((a, b) => b - a);
  return {
    rounds,
    ready: rounds - count,
    reloading,
    nextReadyTicks:
      count === 0 ? 0 : Math.max(0, Math.ceil(spec.reloadTicks - longest)),
  };
}

/** One pip of a reload bar. */
export interface ReloadPip {
  /** How full it is, 0-1. */
  fill: number;
  /** A loaded round (drawn in the ready color). */
  ready: boolean;
}

/** Above this many rounds the bar is one bar, not a pip per round. */
export const MAX_RELOAD_PIPS = 8;

/**
 * The pips to draw: ready rounds full, then each reloading round as full as
 * it is. One-round units get one bar that fills. A unit with more than
 * `maxPips` rounds gets one bar filled by the share of its rounds loaded.
 */
export function reloadPips(
  state: ReloadState,
  maxPips: number = MAX_RELOAD_PIPS,
): ReloadPip[] {
  if (state.rounds <= 0) return [];
  if (state.rounds > maxPips) {
    let loaded = state.ready;
    for (const fill of state.reloading) loaded += fill;
    return [{ fill: loaded / state.rounds, ready: false }];
  }
  const pips: ReloadPip[] = [];
  for (let i = 0; i < state.ready; i++) pips.push({ fill: 1, ready: true });
  for (const fill of state.reloading) pips.push({ fill, ready: false });
  return pips;
}

/** The fields of a unit the reload bar reads (UnitState has them all). */
export interface ReloadingUnit {
  unitType: string;
  level: number;
  isActive: boolean;
  underConstruction: boolean;
  missileTimerQueue: readonly number[];
}

/**
 * The reload bar of a unit at `tick`, or null when none is drawn: a unit
 * that doesn't reload, one that is gone or still being built, and one with
 * every round ready.
 */
export function reloadBar(
  unit: ReloadingUnit,
  tick: number,
  config: ReloadConfig,
): ReloadPip[] | null {
  if (!unit.isActive || unit.underConstruction) return null;
  if (unit.missileTimerQueue.length === 0) return null;
  const spec = reloadSpec(unit.unitType, unit.level, config);
  if (spec === null) return null;
  const state = reloadState(unit.missileTimerQueue, spec, tick);
  if (state.ready >= state.rounds) return null;
  return reloadPips(state);
}

/** Seconds until the next round loads, to one decimal place. */
export function nextReadySeconds(
  state: ReloadState,
  msPerTick: number,
): string {
  return ((state.nextReadyTicks * msPerTick) / 1000).toFixed(1);
}
