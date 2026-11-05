import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { capitalHoldGoldBonusPct } from "@openfront/engine-lib/game/ConventionalWar";

/**
 * Conventional war capitals as the HUD shows them, read from the views the
 * engine sends (rules in packages/engine/src/game/Capital.ts). A capital is
 * its player's spawn tile for the whole game, so who owns that tile says
 * whether it is lost and who holds it.
 */

/** The parts of a player view these read. */
export interface CapitalPlayer {
  state: { capitalTile?: TileRef };
  smallID(): number;
  type(): PlayerType;
  isAlive(): boolean;
  isFriendly(other: CapitalPlayer): boolean;
}

/** The parts of the game view these read. */
export interface CapitalGame<P extends CapitalPlayer> {
  ownerID(tile: TileRef): number;
  players(): P[];
}

/** Whether `player`'s capital is held by someone else (or nobody). */
export function isCapitalLost(
  game: CapitalGame<CapitalPlayer>,
  player: CapitalPlayer,
): boolean {
  const tile = player.state.capitalTile;
  return tile !== undefined && game.ownerID(tile) !== player.smallID();
}

/**
 * The gold income bonus, in percent, `player` gets for the enemy capitals
 * they hold: living players' capitals, never a tribe's or a friend's. The
 * engine's heldEnemyCapitals counts the same ones.
 */
export function heldCapitalsGoldBonusPct<P extends CapitalPlayer>(
  game: CapitalGame<P>,
  player: P,
): number {
  let held = 0;
  for (const other of game.players()) {
    const tile = other.state.capitalTile;
    if (tile === undefined || game.ownerID(tile) !== player.smallID()) continue;
    if (other === player || other.type() === PlayerType.Bot) continue;
    if (!other.isAlive() || player.isFriendly(other)) continue;
    held++;
  }
  return capitalHoldGoldBonusPct(held);
}
