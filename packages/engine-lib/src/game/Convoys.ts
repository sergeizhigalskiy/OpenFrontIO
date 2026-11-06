/**
 * Troop convoy rules: who ambushes a convoy, what a hostile tile or a shell
 * costs it, and which of its routes it takes. The engine (ConvoyExecution
 * and its route planner) and the client's donate panel both run these, so the
 * loss the panel forecasts is the loss the convoy takes.
 */
import type { ConvoyRouteForecast } from "@openfront/engine-api/game/ConvoyForecast";

/**
 * Share of its troops a convoy loses per hostile land tile it enters, in
 * tenths of a percent (15 = 1.5%). Compounded over a route it costs about 26%
 * over 20 tiles, 53% over 50 and 78% over 100, for big and small convoys alike.
 */
export const CONVOY_AMBUSH_PERMILLE = 15;

/**
 * On top of that share, troops lost per hostile land tile as a multiple of
 * the tile owner's troop density (troops / tiles owned).
 */
export const CONVOY_AMBUSH_DENSITY_MULTIPLIER = 5;

/**
 * Share of its troops a convoy loses to one shell, in percent. A defense post
 * or a warship shells a given convoy once.
 */
export const CONVOY_SHELL_LOSS_PERCENT = 25;

/** Convoys a player may have on the road at once. */
export const CONVOY_MAX_IN_FLIGHT = 2;

/**
 * Ticks a nation waits between troop donations (60 s). Nations only send
 * troops to other nations, never to humans, and not at all in Boss Raid
 * (NationAttackBehavior.donateTroops).
 */
export const NATION_TROOP_DONATION_COOLDOWN_TICKS = 600;

/**
 * Route costs per tile entered. The planner takes the cheapest route:
 * land that isn't hostile (the sender's, the recipient's, a friend's or free
 * land) costs 1, water bridged by a short crossing 2, and hostile land 4.
 * City-state land is never entered.
 */
export const CONVOY_COST_SAFE_LAND = 1;
export const CONVOY_COST_WATER = 2;
export const CONVOY_COST_HOSTILE_LAND = 4;

/** Longest water crossing an overland route bridges, in tiles. */
export const CONVOY_MAX_WATER_CROSSING = 6;

/** A forecast step that is a shell hit rather than an ambushed tile. */
export const CONVOY_SHELL_STEP = -1;

/** What the hostility rule reads about a player. */
export interface ConvoyParty<P> {
  isFriendly(other: P, treatAFKFriendly?: boolean): boolean;
  isCityState(): boolean;
}

/**
 * True when `player` ambushes or shells a convoy from `sender` to
 * `recipient`: it is neither of them, friendly with neither of them, and not
 * a city-state (city-states never ambush; routes go around their land). A
 * disconnected friend still counts as friendly.
 */
export function isConvoyHostileTo<P extends ConvoyParty<P>>(
  sender: P,
  recipient: P | null,
  player: P,
): boolean {
  if (player === sender || player === recipient) return false;
  if (player.isCityState()) return false;
  if (sender.isFriendly(player, true)) return false;
  return recipient === null || !recipient.isFriendly(player, true);
}

/**
 * The flat part of the ambush on one tile of an owner holding `ownerTroops`
 * on `ownerTiles` tiles: CONVOY_AMBUSH_DENSITY_MULTIPLIER x its density.
 */
export function convoyAmbushDensityLoss(
  ownerTroops: number,
  ownerTiles: number,
): number {
  if (ownerTiles <= 0) return 0;
  return Math.floor(
    (ownerTroops * CONVOY_AMBUSH_DENSITY_MULTIPLIER) / ownerTiles,
  );
}

/** Troops a convoy of `troops` loses entering one hostile land tile. */
export function convoyAmbushLoss(troops: number, densityLoss: number): number {
  return Math.ceil((troops * CONVOY_AMBUSH_PERMILLE) / 1000) + densityLoss;
}

/** Troops a convoy of `troops` loses to one shell. */
export function convoyShellLoss(troops: number): number {
  return Math.ceil((troops * CONVOY_SHELL_LOSS_PERCENT) / 100);
}

/**
 * Troops a convoy of `troops` loses along `steps` (a forecast's ambushed
 * tiles and shells, in order), at most all of them.
 */
export function convoyLossAlong(
  troops: number,
  steps: readonly number[],
): number {
  let left = troops;
  for (const step of steps) {
    if (left <= 0) break;
    left -=
      step === CONVOY_SHELL_STEP
        ? convoyShellLoss(left)
        : convoyAmbushLoss(left, step);
  }
  return troops - Math.max(0, left);
}

/**
 * The route a convoy of `troops` takes among `options`: the one that loses
 * the fewest troops, then the shortest, then the first listed (the planner
 * lists the overland route before the sea route). Null without options.
 */
export function chooseConvoyRoute<
  R extends Pick<ConvoyRouteForecast, "length" | "steps">,
>(troops: number, options: readonly R[]): R | null {
  let best: R | null = null;
  let bestLoss = Infinity;
  for (const option of options) {
    const loss = convoyLossAlong(troops, option.steps);
    if (
      best === null ||
      loss < bestLoss ||
      (loss === bestLoss && option.length < best.length)
    ) {
      best = option;
      bestLoss = loss;
    }
  }
  return best;
}
