/**
 * Trade-route cutting: rail cuts and naval blockades.
 *
 * Rail cuts: a station-to-station railroad is cut when a player who is
 * neither one of the rail's owners (the owners of the stations at its ends)
 * nor friendly to both of them captures one of its tiles. A rail laid across
 * a third party's land starts live. Trains don't route over a cut rail and
 * it carries no income; it reconnects by itself once every cut tile is back
 * with an owner or a friend of both (see engine game/RailCuts.ts).
 *
 * Blockades: a port is blockaded while a warship of a player at war with the
 * port's owner is within BLOCKADE_RANGE tiles of it. At war (atWarBy) means
 * they aren't allied or teammates, and one of them is attacking the other
 * right now or launched a land attack, a boat attack or a nuke at the other
 * within the last WAR_MEMORY_TICKS; a warship merely passing by does
 * nothing. A blockaded port launches trade ships at
 * 1/BLOCKADE_TRADE_SHIP_RATE_DIVISOR of its normal rate and nobody picks it
 * as a trade destination; ships already at sea sail on, and trains are
 * unaffected.
 *
 * Shared by the engine (the rules) and the client (the blockade marker), so
 * every tunable number lives here.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";

/** Ticks between two scans of every railroad for cuts (10 ticks = 1 s). */
export const RAIL_CUT_CHECK_INTERVAL = 10;

/** A warship at war within this many tiles (euclidean) blockades a port. */
export const BLOCKADE_RANGE = 25;

/**
 * A blockaded port launches trade ships at 1/this of its normal rate: it
 * tries on one spawn check in this many.
 */
export const BLOCKADE_TRADE_SHIP_RATE_DIVISOR = 2;

/** Ticks between two blockade checks of a port (10 ticks = 1 s). */
export const BLOCKADE_CHECK_INTERVAL = 10;

/**
 * Two players stay at war this long (ticks: 2 minutes) after either one last
 * launched a land attack, a boat attack or a nuke at the other.
 */
export const WAR_MEMORY_TICKS = 1200;

/** What the war rule reads; the engine and the client each supply it. */
export interface WarFacts<P> {
  /** Allied or on the same team. */
  friendly(a: P, b: P): boolean;
  /** `attacker` has a land attack on `target` running right now. */
  attacking(attacker: P, target: P): boolean;
  /**
   * The last tick `attacker` launched a land attack, a boat attack or a nuke
   * at `target`, or undefined if it never did (or not recently enough to be
   * kept).
   */
  lastHostileAct(attacker: P, target: P): number | undefined;
}

/**
 * Whether `a` and `b` are at war at tick `now`: not friendly, and either is
 * attacking the other or launched an attack at it less than
 * WAR_MEMORY_TICKS ago.
 */
export function atWarBy<P>(
  facts: WarFacts<P>,
  a: P,
  b: P,
  now: number,
): boolean {
  if (a === b || facts.friendly(a, b)) return false;
  if (facts.attacking(a, b) || facts.attacking(b, a)) return true;
  return (
    hostileActIsRecent(facts.lastHostileAct(a, b), now) ||
    hostileActIsRecent(facts.lastHostileAct(b, a), now)
  );
}

/** Whether a hostile act launched at `tick` (undefined: none) still counts. */
export function hostileActIsRecent(
  tick: number | undefined,
  now: number,
): boolean {
  return tick !== undefined && now - tick < WAR_MEMORY_TICKS;
}

/** The spatial query the blockade rule needs; Game and GameView both have it. */
export interface BlockadeQuery<U> {
  anyUnitNearby(
    tile: TileRef,
    searchRange: number,
    types: readonly UnitType[],
    predicate: (unit: U) => boolean,
  ): boolean;
}

/**
 * The first warship (in spatial-grid order, so deterministic) that
 * blockades a port of `portOwner` at `portTile`, or null if none does.
 * `atWar` answers whether two players are at war (atWarBy): the engine and
 * the client each apply it to their own view of the game.
 */
export function findPortBlockader<P, U extends { owner(): P }>(
  game: BlockadeQuery<U>,
  portTile: TileRef,
  portOwner: P,
  atWar: (a: P, b: P) => boolean,
): U | null {
  let blockader: U | null = null;
  game.anyUnitNearby(portTile, BLOCKADE_RANGE, [UnitType.Warship], (ship) => {
    const owner = ship.owner();
    if (owner === portOwner || !atWar(owner, portOwner)) return false;
    blockader = ship;
    return true;
  });
  return blockader;
}
