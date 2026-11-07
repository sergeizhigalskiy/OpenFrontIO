import { PROTECTED_STATE_BADGE } from "@openfront/engine-lib/game/ProtectedState";
import type { GameView, PlayerView } from "../view";

/**
 * The Protected State on the client (engine-lib game/ProtectedState.ts): its
 * badge on the leaderboard, over its name on the map and in the hover
 * overlay, and its patrons in its player panel. All empty while the mode is
 * off.
 */

/** Whether `player` is the Protected State. */
export function isProtectedState(game: GameView, player: PlayerView): boolean {
  const id = game.cataclysm().protectedStateID();
  return id !== 0 && player.smallID() === id;
}

/** `player`'s leaderboard name: the Protected State's carries its badge. */
export function leaderboardName(game: GameView, player: PlayerView): string {
  return isProtectedState(game, player)
    ? `${PROTECTED_STATE_BADGE} ${player.name()}`
    : player.name();
}

/** The badge to draw over each player's name on the map, by smallID. */
export function nameBadges(game: GameView): ReadonlyMap<number, string> {
  const id = game.cataclysm().protectedStateID();
  return id === 0 ? new Map() : new Map([[id, PROTECTED_STATE_BADGE]]);
}

/** `player`'s patrons, strongest first, when it is the Protected State. */
export function patronsOf(game: GameView, player: PlayerView): PlayerView[] {
  if (!isProtectedState(game, player)) return [];
  const patrons: PlayerView[] = [];
  for (const id of game.cataclysm().patronIDs()) {
    const p = game.playerBySmallID(id);
    if (p.isPlayer()) patrons.push(p as PlayerView);
  }
  return patrons;
}
