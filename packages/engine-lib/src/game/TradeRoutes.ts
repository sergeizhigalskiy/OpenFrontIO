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
 * Blockades: a port is blockaded while a warship of a player hostile to the
 * port's owner is within BLOCKADE_RANGE tiles of it. A blockaded port
 * launches no trade ships and nobody picks it as a trade destination; ships
 * already at sea sail on, and trains are unaffected.
 *
 * Shared by the engine (the rules) and the client (the blockade marker), so
 * every tunable number lives here.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";

/** Ticks between two scans of every railroad for cuts (10 ticks = 1 s). */
export const RAIL_CUT_CHECK_INTERVAL = 10;

/** A hostile warship within this many tiles (euclidean) blockades a port. */
export const BLOCKADE_RANGE = 40;

/** Ticks between two blockade checks of a port (10 ticks = 1 s). */
export const BLOCKADE_CHECK_INTERVAL = 10;

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
 * `friendly` answers whether two players are allied or on the same team.
 */
export function findPortBlockader<P, U extends { owner(): P }>(
  game: BlockadeQuery<U>,
  portTile: TileRef,
  portOwner: P,
  friendly: (a: P, b: P) => boolean,
): U | null {
  let blockader: U | null = null;
  game.anyUnitNearby(portTile, BLOCKADE_RANGE, [UnitType.Warship], (ship) => {
    const owner = ship.owner();
    if (owner === portOwner || friendly(owner, portOwner)) return false;
    blockader = ship;
    return true;
  });
  return blockader;
}
