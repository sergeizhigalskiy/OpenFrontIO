/**
 * Horde Night (co-op survival) rules, shared by the sim (HordeNightExecution,
 * HordeBandExecution, WinCheckExecution) and the client HUD, so the wave
 * counter on screen is the schedule the sim runs.
 *
 * Every human and nation plays on one allied side (HORDE_DEFENDERS_TEAM).
 * After the spawn phase plus HORDE_FIRST_WAVE_DELAY_TICKS, and then every
 * HORDE_WAVE_INTERVAL_TICKS, a wave lands for each living defender: a share
 * of that defender's max troops, split into bands that land on free coast or
 * map edge near it (or sail in from the map edge) and attack it until it
 * falls. The bands are bots on HORDE_TEAM that never ally, keep the troops
 * they land with (no growth, no cap) and disband once they have bled out.
 *
 * Each human's land is recorded when the first wave lands. A human holding
 * under HORDE_OVERRUN_PERCENT of it is overrun. The horde wins when every
 * human is dead or overrun; the defenders win at the survival timer, outright
 * if a human still holds HORDE_HOLD_PERCENT of their land, narrowly
 * otherwise. Integer math only.
 *
 * All times are in ticks since the spawn phase ended (10 ticks a second).
 */
import { PlayerType, type Team } from "@openfront/engine-api/game/GameTypes";

/** Every human and nation plays on this team, so they are all friendly. */
export const HORDE_DEFENDERS_TEAM: Team = "Defenders";
/** Every horde band is on this team: bands never fight each other. */
export const HORDE_TEAM: Team = "Horde";

/** The survival timer when the lobby leaves it unset, in minutes: 8 waves. */
export const HORDE_NIGHT_DEFAULT_SURVIVAL_MINUTES = 25;
/** The survival timers the lobby offers, in minutes. */
export const HORDE_NIGHT_SURVIVAL_CHOICES: readonly number[] = [
  15, 20, 25, 30, 45,
];
/** Bounds of the survival timer the schema accepts, in minutes. */
export const HORDE_NIGHT_MIN_SURVIVAL_MINUTES = 1;
export const HORDE_NIGHT_MAX_SURVIVAL_MINUTES = 120;

/** The first wave lands this long after the spawn phase ends: 2 minutes. */
export const HORDE_FIRST_WAVE_DELAY_TICKS = 2 * 60 * 10;
/** Then a wave lands every 3 minutes. */
export const HORDE_WAVE_INTERVAL_TICKS = 3 * 60 * 10;

/** A human's wave 1 is this percent of the human's max troops: 0.35x. */
export const HORDE_HUMAN_WAVE_PERCENT = 35;
/** A nation's own, smaller wave 1: 0.15x its max troops. */
export const HORDE_NATION_WAVE_PERCENT = 15;
/** Each wave after the first is this percent of wave 1 stronger: +25%. */
export const HORDE_WAVE_GROWTH_PERCENT = 25;
/** A wave splits into this many bands plus one per two wave numbers. */
export const HORDE_BASE_BAND_COUNT = 2;

/** Bands land on free coast or map edge within this many tiles of their defender. */
export const HORDE_LANDING_RANGE = 150;
/** Radius of the patch of free land a band lands on. */
export const HORDE_BAND_LANDING_RADIUS = 4;
/** A defender's bands land at least this far apart while the coast allows. */
export const HORDE_BAND_MIN_SPACING = 30;
/** Tries to place each band at the spacing before it is relaxed. */
export const HORDE_BAND_PLACEMENT_TRIES = 200;
/** Border tiles sampled per player when measuring distances to it. */
export const HORDE_BAND_TARGET_SAMPLES = 128;
/** A band sends its next attack every this many ticks. */
export const HORDE_BAND_ATTACK_INTERVAL_TICKS = 10;
/** A band whose defender fell looks for the nearest one this often. */
export const HORDE_BAND_RETARGET_TICKS = 100;

/** Cleanup: a band this long after landing ... */
export const HORDE_BAND_CLEANUP_TICKS = 90 * 10;
/** ... that holds under this percent of its landing troops disbands. */
export const HORDE_BAND_CLEANUP_PERCENT = 10;

/** Each human's land is recorded when the first wave lands (2:00). */
export const HORDE_START_LAND_TICKS = HORDE_FIRST_WAVE_DELAY_TICKS;
/** A human under this percent of their recorded land is overrun. */
export const HORDE_OVERRUN_PERCENT = 25;
/** At the timer, a human holding this percent of it wins outright. */
export const HORDE_HOLD_PERCENT = 50;

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
 * A defender's whole wave: `percent` of its `maxTroops` (HORDE_HUMAN_WAVE_PERCENT
 * or HORDE_NATION_WAVE_PERCENT), grown by HORDE_WAVE_GROWTH_PERCENT per wave
 * after the first, floored. For a human: wave 5 is 0.70x, wave 10 1.14x.
 */
export function hordeWavePool(
  maxTroops: number,
  wave: number,
  percent: number,
): number {
  return Math.floor(
    (maxTroops * percent * (100 + HORDE_WAVE_GROWTH_PERCENT * (wave - 1))) /
      10_000,
  );
}

/** How many bands a defender's wave `wave` splits into: 2 + wave / 2. */
export function hordeBandCount(wave: number): number {
  return HORDE_BASE_BAND_COUNT + Math.floor(wave / 2);
}

/** Whether a band holding `troops` of its `landingTroops` has bled out. */
export function hordeBandSpent(troops: number, landingTroops: number): boolean {
  return troops * 100 < landingTroops * HORDE_BAND_CLEANUP_PERCENT;
}

/**
 * The outcome so far, as WinCheckExecution sets it: "horde" once every
 * defending human that spawned is dead or overrun; at the survival timer
 * "defenders" if one holds HORDE_HOLD_PERCENT of their recorded land,
 * otherwise "narrow".
 */
export type HordeNightOutcome = "defenders" | "narrow" | "horde" | null;

/** A defending human, for the outcome. `startTiles` is null until recorded. */
export interface HordeHuman {
  alive: boolean;
  tiles: number;
  startTiles: number | null;
}

/** Whether `human` holds under HORDE_OVERRUN_PERCENT of their recorded land. */
export function hordeOverrun(human: HordeHuman): boolean {
  return (
    human.startTiles !== null &&
    human.tiles * 100 < human.startTiles * HORDE_OVERRUN_PERCENT
  );
}

export function hordeNightOutcome(input: {
  humans: readonly HordeHuman[];
  ticksSinceStart: number;
  survivalMinutes: number;
}): HordeNightOutcome {
  if (input.humans.length === 0) return null;
  const standing = input.humans.filter((h) => h.alive && !hordeOverrun(h));
  if (standing.length === 0) return "horde";
  if (input.ticksSinceStart < input.survivalMinutes * 60 * 10) return null;
  const holds = standing.some(
    (h) =>
      h.startTiles === null ||
      h.tiles * 100 >= h.startTiles * HORDE_HOLD_PERCENT,
  );
  return holds ? "defenders" : "narrow";
}

/** A horde band (works on engine players and client views alike). */
export function isHordeBand(player: { team(): Team | null }): boolean {
  return player.team() === HORDE_TEAM;
}

/** A defending human or nation. */
export function isHordeDefender(player: { team(): Team | null }): boolean {
  return player.team() === HORDE_DEFENDERS_TEAM;
}

// Horde boats: the transport ships of horde bands, sailing in from the map
// edge or launched by a band ashore. Hard to stop at sea.

/** A shell kills this percent of a horde boat's troops (rounded up), not the boat. */
export const HORDE_BOAT_SHELL_LOSS_PERCENT = 10;
/** A water tile a hostile warship covers costs this many plain tiles to a horde boat. */
export const HORDE_BOAT_EXPOSED_TILE_COST = 8;
/** A horde boat plans its route again this often while sailing: 2 s. */
export const HORDE_BOAT_REPLAN_TICKS = 20;

/** Troops one shell kills on a horde boat holding `troops`. */
export function hordeBoatShellLoss(troops: number): number {
  return Math.ceil((troops * HORDE_BOAT_SHELL_LOSS_PERCENT) / 100);
}

/**
 * Whether a warship owned by `shooter` may fire at a horde boat sailing at
 * `aimedAt`: its owner's own, and between humans each other's, so friends
 * can defend each other. Nations leave boats sent at anyone else alone.
 */
export function mayShootHordeBoat(
  shooter: { type(): PlayerType },
  aimedAt: { type(): PlayerType } | null | undefined,
): boolean {
  if (aimedAt === null || aimedAt === undefined) return false;
  if (shooter === aimedAt) return true;
  return (
    shooter.type() === PlayerType.Human && aimedAt.type() === PlayerType.Human
  );
}
