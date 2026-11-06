import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  atWarBy,
  findPortBlockader,
  type WarFacts,
} from "@openfront/engine-lib/game/TradeRoutes";
import type { Game, Player, Unit } from "./Game";
import { tradeFriendly } from "./RailCuts";

/**
 * Naval blockades (rules in engine-lib game/TradeRoutes): the warship
 * blockading `port`, or null. One spatial query, and none at all while
 * nobody has a warship.
 */
export function portBlockader(game: Game, port: Unit): Unit | null {
  if (game.unitCount(UnitType.Warship) === 0) return null;
  return findPortBlockader(game, port.tile(), port.owner(), (a, b) =>
    atWar(game, a, b),
  );
}

/** The war rule's facts as the engine knows them. */
const ENGINE_WAR_FACTS: WarFacts<Player> = {
  friendly: tradeFriendly,
  attacking: (attacker, target) =>
    attacker
      .outgoingAttacks()
      .some((attack) => attack.isActive() && attack.target() === target),
  lastHostileAct: (attacker, target) => attacker.lastHostileActTick(target),
};

/**
 * Whether `a` and `b` are at war now, the blockade test (engine-lib
 * TradeRoutes.atWarBy): not allied or teammates, and one is attacking the
 * other or launched a land attack, boat attack or nuke at it within the
 * last WAR_MEMORY_TICKS. The client's blockade ring applies the same rule.
 */
export function atWar(game: Game, a: Player, b: Player): boolean {
  return atWarBy(ENGINE_WAR_FACTS, a, b, game.ticks());
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
