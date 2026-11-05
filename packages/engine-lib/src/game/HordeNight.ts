/**
 * Horde Night (co-op survival) rules, shared by the sim (HordeNightExecution,
 * HordeBandExecution, WinCheckExecution) and the client HUD, so the wave
 * counter on screen is the schedule the sim runs.
 *
 * Every human and nation plays on one allied side (HORDE_DEFENDERS_TEAM).
 * After the spawn phase plus HORDE_FIRST_WAVE_DELAY_TICKS, a wave of hostile
 * horde bands lands on the map edges and coasts every
 * HORDE_WAVE_INTERVAL_TICKS. The bands are tribe-like bots on HORDE_TEAM that
 * attack the nearest non-horde player and never ally. The defenders win once
 * a defending human has survived the lobby's survival timer, and lose when
 * every defending human is gone. Integer math only.
 *
 * All times are in ticks since the spawn phase ended (10 ticks a second).
 */
import type { Team } from "@openfront/engine-api/game/GameTypes";

/** Every human and nation plays on this team, so they are all friendly. */
export const HORDE_DEFENDERS_TEAM: Team = "Defenders";
/** Every horde band is on this team: bands never fight each other. */
export const HORDE_TEAM: Team = "Horde";

/** The survival timer when the lobby leaves it unset, in minutes. */
export const HORDE_NIGHT_DEFAULT_SURVIVAL_MINUTES = 30;
/** Bounds of the lobby's survival timer, in minutes (as the schema). */
export const HORDE_NIGHT_MIN_SURVIVAL_MINUTES = 1;
export const HORDE_NIGHT_MAX_SURVIVAL_MINUTES = 120;

/** The first wave lands this long after the spawn phase ends: 2 minutes. */
export const HORDE_FIRST_WAVE_DELAY_TICKS = 2 * 60 * 10;
/** Then a wave lands every 3 minutes. */
export const HORDE_WAVE_INTERVAL_TICKS = 3 * 60 * 10;

/** A wave's troop pool per wave number, before the defender bonus. */
export const HORDE_TROOPS_PER_WAVE = 40_000;
/** Each defending player adds this percent of the base pool (the 0.5×). */
export const HORDE_DEFENDER_BONUS_PERCENT = 50;
/** A wave splits into this many bands plus one per wave number. */
export const HORDE_BASE_BAND_COUNT = 2;

/** Radius of the patch of land a band lands on. */
export const HORDE_BAND_LANDING_RADIUS = 4;
/** Bands of one wave land at least this far apart while the coast allows. */
export const HORDE_BAND_MIN_SPACING = 30;
/** Tries to place each band at the spacing before it is relaxed. */
export const HORDE_BAND_PLACEMENT_TRIES = 200;
/** A band sends its next attack every this many ticks. */
export const HORDE_BAND_ATTACK_INTERVAL_TICKS = 10;
/** A band looks for the nearest player again every this many ticks. */
export const HORDE_BAND_RETARGET_TICKS = 100;
/** Border tiles sampled per player when a band measures who is nearest. */
export const HORDE_BAND_TARGET_SAMPLES = 256;

/** Ticks since the spawn phase ended at which wave `wave` (1-based) lands. */
export function hordeWaveLandingTick(wave: number): number {
  return HORDE_FIRST_WAVE_DELAY_TICKS + (wave - 1) * HORDE_WAVE_INTERVAL_TICKS;
}

/** How many waves have landed `ticksSinceStart` ticks after the spawn phase. */
export function hordeWavesLanded(ticksSinceStart: number): number {
  if (ticksSinceStart < HORDE_FIRST_WAVE_DELAY_TICKS) return 0;
  return (
    1 +
    Math.floor(
      (ticksSinceStart - HORDE_FIRST_WAVE_DELAY_TICKS) /
        HORDE_WAVE_INTERVAL_TICKS,
    )
  );
}

/** Ticks until the next wave lands. */
export function hordeTicksUntilNextWave(ticksSinceStart: number): number {
  return (
    hordeWaveLandingTick(hordeWavesLanded(ticksSinceStart) + 1) -
    ticksSinceStart
  );
}

/**
 * The wave's whole troop pool: 40,000 × wave × (1 + 0.5 × defenders), as
 * exact integer math (the percent form never leaves the integers).
 */
export function hordeWavePool(wave: number, defenders: number): number {
  return (
    (HORDE_TROOPS_PER_WAVE *
      wave *
      (100 + HORDE_DEFENDER_BONUS_PERCENT * defenders)) /
    100
  );
}

/** How many bands wave `wave` splits into: 2 + wave. */
export function hordeBandCount(wave: number): number {
  return HORDE_BASE_BAND_COUNT + wave;
}

/** Each band's share of the wave's pool, floored. */
export function hordeBandTroops(wave: number, defenders: number): number {
  return Math.floor(hordeWavePool(wave, defenders) / hordeBandCount(wave));
}

export type HordeNightOutcome = "defenders" | "horde" | null;

/**
 * Who has won. The horde wins once every defending human that spawned is
 * gone; the defenders win when one is still alive at the survival timer. A
 * game in which no defending human ever spawned is left to the usual checks.
 */
export function hordeNightOutcome(input: {
  spawnedHumans: number;
  aliveHumans: number;
  ticksSinceStart: number;
  survivalMinutes: number;
}): HordeNightOutcome {
  if (input.spawnedHumans === 0) return null;
  if (input.aliveHumans === 0) return "horde";
  if (input.ticksSinceStart >= input.survivalMinutes * 60 * 10) {
    return "defenders";
  }
  return null;
}

/** A horde band (works on engine players and client views alike). */
export function isHordeBand(player: { team(): Team | null }): boolean {
  return player.team() === HORDE_TEAM;
}

/** A defending human or nation. */
export function isHordeDefender(player: { team(): Team | null }): boolean {
  return player.team() === HORDE_DEFENDERS_TEAM;
}
