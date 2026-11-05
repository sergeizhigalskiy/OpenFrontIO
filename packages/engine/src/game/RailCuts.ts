import { MessageType } from "@openfront/engine-api/game/GameTypes";
import type { Game, Player } from "./Game";
import type { RailNetworkImpl } from "./RailNetworkImpl";
import type { Railroad } from "./Railroad";

/**
 * Rail cuts (constants in engine-lib game/TradeRoutes): capturing an enemy
 * rail tile cuts that line's train income.
 *
 * A railroad belongs to the owners of the stations at its two ends. A tile
 * under it is cut when a hostile player captures it: its owner changes to a
 * player who is neither end owner nor friendly to both. So a rail laid
 * across a third party's land starts live and stays live until a capture.
 * A cut tile heals once its owner is an end owner or a friend of both
 * again (a hostile taking it from another hostile keeps it cut), and the
 * rail reconnects when no cut tile is left.
 *
 * Captures are found by comparing each rail tile's owner against the one
 * the last scan saw (Railroad.owners), every RAIL_CUT_CHECK_INTERVAL ticks.
 * GameImpl.conquer runs for every tile of every attack, too hot a path for
 * a rail lookup per tile.
 */

/** Allied or on the same team. A disconnected teammate stays friendly. */
export function tradeFriendly(a: Player, b: Player): boolean {
  return a === b || a.isOnSameTeam(b) || a.isAlliedWith(b);
}

/** Whether the owner `id` (0: nobody) may hold a tile of `a`-`b`'s rail. */
function friendOfRail(game: Game, id: number, a: Player, b: Player): boolean {
  if (id === a.smallID() || id === b.smallID()) return true;
  if (id === 0) return false;
  const holder = game.playerBySmallID(id);
  return (
    holder.isPlayer() && tradeFriendly(holder, a) && tradeFriendly(holder, b)
  );
}

/** Starts watching `rail`'s tiles: who holds them now is no capture. */
export function trackRailOwners(game: Game, rail: Railroad): void {
  const owners = new Uint16Array(rail.tiles.length);
  for (let i = 0; i < rail.tiles.length; i++) {
    owners[i] = game.ownerID(rail.tiles[i]);
  }
  rail.owners = owners;
}

/**
 * Gives `half`, the part of the split `original` that starts at its tile
 * index `start`, the owners and cut tiles of that stretch.
 */
export function inheritRailCuts(
  original: Railroad,
  half: Railroad,
  start: number,
): void {
  if (original.owners.length === original.tiles.length) {
    half.owners = original.owners.slice(start, start + half.tiles.length);
  }
  const tiles = new Set(half.tiles);
  half.cutTiles = original.cutTiles.filter((t) => tiles.has(t));
}

/**
 * Heals `rail`'s cut tiles that are back with a friend, then cuts the tiles
 * a hostile player captured since the last scan. Returns the player whose
 * capture cut the first new tile, or null. The first scan of a rail only
 * records its owners.
 */
export function updateRailCuts(game: Game, rail: Railroad): Player | null {
  const tiles = rail.tiles;
  if (rail.owners.length !== tiles.length) {
    trackRailOwners(game, rail);
    return null;
  }
  const a = rail.from.unit.owner();
  const b = rail.to.unit.owner();
  if (rail.cutTiles.length > 0) {
    rail.cutTiles = rail.cutTiles.filter(
      (t) => !friendOfRail(game, game.ownerID(t), a, b),
    );
  }
  let cutter: Player | null = null;
  const owners = rail.owners;
  for (let i = 0; i < tiles.length; i++) {
    const id = game.ownerID(tiles[i]);
    if (id === owners[i]) continue;
    owners[i] = id;
    // Land falling to nobody or to a friend is no capture.
    if (id === 0 || friendOfRail(game, id, a, b)) continue;
    if (!rail.cutTiles.includes(tiles[i])) rail.cutTiles.push(tiles[i]);
    cutter ??= game.playerBySmallID(id) as Player;
  }
  return cutter;
}

/**
 * Scans every railroad, cuts and reconnects them, and tells each owner
 * once per scan per cutter that a line of theirs was cut. Stations and
 * their rails are visited in their stored order, so this is deterministic.
 */
export function refreshRailCuts(game: Game, network: RailNetworkImpl): void {
  const notices = new Map<string, { owner: Player; cutter: Player }>();
  for (const station of network.stationManager().getAll()) {
    for (const rail of station.getRailroads()) {
      // Each rail is listed by both of its stations; visit it once.
      if (rail.from !== station) continue;
      const wasCut = rail.isCut();
      const cutter = updateRailCuts(game, rail);
      if (cutter !== null && !wasCut) {
        for (const owner of [rail.from.unit.owner(), rail.to.unit.owner()]) {
          if (tradeFriendly(cutter, owner)) continue;
          notices.set(`${owner.smallID()}:${cutter.smallID()}`, {
            owner,
            cutter,
          });
        }
      }
      network.syncRailroadCut(rail, wasCut);
    }
  }
  for (const { owner, cutter } of notices.values()) {
    game.displayMessage(
      "events_display.rail_cut",
      MessageType.UNIT_DESTROYED,
      owner.id(),
      undefined,
      { name: cutter.displayName() },
      undefined,
      cutter.id(),
    );
  }
}
