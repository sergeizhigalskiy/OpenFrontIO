import type { Game, Player } from "./Game";

/**
 * Who takes The Infected's last tiles (engine-lib/game/Plague.ts): the game's
 * plague registers itself here, and GameImpl.conquerPlayer reports each
 * conquest of The Infected, so the cure is paid to whoever finished it off.
 */
export interface InfectedConquestListener {
  infectedConquered(conqueror: Player): void;
}

const listeners = new WeakMap<Game, InfectedConquestListener>();

export function listenForInfectedConquest(
  game: Game,
  listener: InfectedConquestListener,
): void {
  listeners.set(game, listener);
}

export function reportInfectedConquered(game: Game, conqueror: Player): void {
  listeners.get(game)?.infectedConquered(conqueror);
}
