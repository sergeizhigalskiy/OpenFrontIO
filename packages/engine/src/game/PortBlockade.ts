import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { findPortBlockader } from "@openfront/engine-lib/game/TradeRoutes";
import type { Game, Unit } from "./Game";
import { tradeFriendly } from "./RailCuts";

/**
 * Naval blockades (rules in engine-lib game/TradeRoutes): the warship
 * blockading `port`, or null. One spatial query, and none at all while
 * nobody has a warship.
 */
export function portBlockader(game: Game, port: Unit): Unit | null {
  if (game.unitCount(UnitType.Warship) === 0) return null;
  return findPortBlockader(game, port.tile(), port.owner(), tradeFriendly);
}

/**
 * Re-checks `port` and returns whether it is blockaded now. When a blockade
 * starts, its owner is told once.
 */
export function refreshPortBlockade(
  game: Game,
  port: Unit,
  wasBlockaded: boolean,
): boolean {
  const blockader = portBlockader(game, port);
  if (blockader !== null && !wasBlockaded) {
    game.displayMessage(
      "events_display.port_blockaded",
      MessageType.UNIT_DESTROYED,
      port.owner().id(),
      undefined,
      { name: blockader.owner().displayName() },
      port.id(),
      blockader.owner().id(),
    );
  }
  return blockader !== null;
}
