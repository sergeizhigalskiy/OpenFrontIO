// Designer settings: the only two lines to edit.
// PROTECTED_STATE_NATION: the nation that gets the status, its name exactly
// as it appears on the map, in quotes, for example "Luxembourg" (capitals
// don't matter). Leave it null to give it to the smallest nation.
// PROTECTED_STATE_MODE_NAME: the mode's name in the lobby and the in-game
// messages. Set it to anything.
export const PROTECTED_STATE_NATION: string | null = null;
export const PROTECTED_STATE_MODE_NAME = "Protected State";

/**
 * Protected State, a lobby mode, off by default, in Free For All and Team
 * games. It can't be played with Boss Raid, Horde Night or the plague
 * (ModeExclusions.ts). The engine side is ProtectedStateExecution.
 *
 * - When the spawn phase ends one nation becomes the Protected State: the one
 *   named PROTECTED_STATE_NATION, or, when that is null or the map has no
 *   nation by that name, the nation with the fewest tiles. Only nations
 *   qualify. If it is eliminated the mode ends and nobody takes its place.
 * - Its patrons are the PROTECTED_STATE_PATRONS strongest nations by troops
 *   (never a human, a tribe or a city-state), recomputed every
 *   PATRON_RECOMPUTE_TICKS. They never attack it and never break an alliance
 *   with it.
 * - It earns PROTECTED_INCOME_MULTIPLIER times the gold, and every
 *   TRIBUTE_TICKS pays TRIBUTE_SHARE of the gold it earned over them to its
 *   patrons, split evenly.
 * - Every PEACE_CONVOY_TICKS each patron sends it PEACE_CONVOY_SHARE of its
 *   troops as a troop convoy; while it is under attack (a hostile attack on it
 *   in the last UNDER_ATTACK_TICKS), WAR_CONVOY_SHARE every WAR_CONVOY_TICKS.
 * - It can call its patrons to war on a player for CALL_TO_WAR_TICKS, at
 *   CALL_TO_WAR_GOLD_SHARE of its gold, at least CALL_TO_WAR_MIN_GOLD, once
 *   every CALL_TO_WAR_COOLDOWN_TICKS.
 *
 * Times are in ticks (10 a second).
 */

/** How many patrons the Protected State has: the strongest nations by troops. */
export const PROTECTED_STATE_PATRONS = 3;
/** Ticks between patron recomputes (60 s). */
export const PATRON_RECOMPUTE_TICKS = 600;

/** Ticks between tribute payments (60 s). */
export const TRIBUTE_TICKS = 600;
/**
 * Share of the gold earned since the last payment that goes to the patrons.
 * Tuned from 0.3: at 0.3 it ended in the top 3 by land in 44% of World
 * games, at 0.6 in 25% (the target is at most 25%).
 */
export const TRIBUTE_SHARE = 0.6;
/** The Protected State earns this many times the gold it otherwise would. */
export const PROTECTED_INCOME_MULTIPLIER = 1.5;
/** Ticks between the income bonus payments (1 s). */
export const INCOME_BONUS_TICKS = 10;

/** Peacetime: ticks between convoys (30 s), and each patron's share of troops. */
export const PEACE_CONVOY_TICKS = 300;
export const PEACE_CONVOY_SHARE = 0.02;
/** Under attack: ticks between convoys (15 s), and each patron's share. */
export const WAR_CONVOY_TICKS = 150;
export const WAR_CONVOY_SHARE = 0.08;
/** The Protected State is under attack for this long after any attack on it (10 s). */
export const UNDER_ATTACK_TICKS = 100;

/** How long a call to war lasts (2 min). */
export const CALL_TO_WAR_TICKS = 1200;
/** What a call to war costs: this share of the Protected State's gold... */
export const CALL_TO_WAR_GOLD_SHARE = 0.25;
/** ...and at least this much gold. */
export const CALL_TO_WAR_MIN_GOLD = 100_000;
/** Ticks from one call to war to the next (3 min). */
export const CALL_TO_WAR_COOLDOWN_TICKS = 1800;
/** The AI calls it on whoever attacked it most over this window (60 s). */
export const CALL_TO_WAR_ATTACK_WINDOW_TICKS = 600;
/** Ticks between the AI's looks at whether to call (1 s). */
export const CALL_TO_WAR_CHECK_TICKS = 10;

/**
 * The badge that marks the Protected State on the leaderboard and over its
 * name on the map. It must be in the map's emoji atlas
 * (resources/atlases/emoji-atlas-meta.json).
 */
export const PROTECTED_STATE_BADGE = "🛡️";

/** Whether a game config turns the mode on. Old configs have no field: off. */
export function protectedStateOn(config: {
  protectedState?: boolean;
}): boolean {
  return config.protectedState === true;
}

/** The `{mode}` text parameter every Protected State string takes. */
export function protectedStateTextParams(): { mode: string } {
  return { mode: PROTECTED_STATE_MODE_NAME };
}

/**
 * Whether the nation called `name` is the one `wanted` names, ignoring case
 * and surrounding spaces. A null or blank `wanted` names nobody.
 */
export function namesProtectedState(
  name: string,
  wanted: string | null = PROTECTED_STATE_NATION,
): boolean {
  if (wanted === null || wanted.trim() === "") return false;
  return name.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/** `amount` times `share`, rounded down, in whole gold. */
function goldShare(amount: bigint, share: number): bigint {
  if (amount <= 0n) return 0n;
  return (amount * BigInt(Math.round(share * 1000))) / 1000n;
}

/** The extra gold the Protected State gets on `earned` gold it earned. */
export function protectedIncomeBonus(earned: bigint): bigint {
  return goldShare(earned, PROTECTED_INCOME_MULTIPLIER - 1);
}

/** What each of `patrons` patrons is paid out of `earned` gold. */
export function tributePerPatron(earned: bigint, patrons: number): bigint {
  if (patrons <= 0) return 0n;
  return goldShare(earned, TRIBUTE_SHARE) / BigInt(patrons);
}

/**
 * What a call to war costs a Protected State holding `gold`, or null when it
 * can't afford one.
 */
export function callToWarCost(gold: bigint): bigint | null {
  const min = BigInt(CALL_TO_WAR_MIN_GOLD);
  const share = goldShare(gold, CALL_TO_WAR_GOLD_SHARE);
  const cost = share > min ? share : min;
  return gold >= cost ? cost : null;
}

/** The troops a patron holding `troops` sends at `share`, rounded down. */
export function patronConvoyTroops(troops: number, share: number): number {
  return Math.max(0, Math.floor(troops * share));
}
