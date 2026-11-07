import type { Game, Player } from "./Game";

/**
 * What the rest of the engine asks the Protected State mode
 * (execution/ProtectedStateExecution.ts, engine-lib game/ProtectedState.ts):
 * attacks, nukes and the nation AI check it so a patron never hits the
 * Protected State, and patrons answer its calls to war.
 */
export interface ProtectedStateMode {
  /** The living Protected State, or null before it is picked and once it falls. */
  protectedState(): Player | null;
  /** Whether `player` is one of the Protected State's patrons now. */
  isPatron(player: Player): boolean;
  /** The player `patron` is called to war against now, or null. */
  callToWarTarget(patron: Player): Player | null;
}

// Each game's mode, while it runs. The execution links itself on init and on
// restore, the way Horde Night does (hordeNightOf).
const modes = new WeakMap<Game, ProtectedStateMode>();

/** Makes `mode` the one `game` answers with. */
export function linkProtectedState(game: Game, mode: ProtectedStateMode): void {
  modes.set(game, mode);
}

/** The game's Protected State mode, or null when it is off. */
export function protectedStateMode(game: Game): ProtectedStateMode | null {
  return modes.get(game) ?? null;
}

/**
 * True when `target` is the Protected State and `attacker` one of its
 * patrons: that attack never happens. Always false with the mode off.
 */
export function isShielded(
  game: Game,
  target: Player,
  attacker: Player,
): boolean {
  const mode = modes.get(game);
  if (mode === undefined) return false;
  return mode.protectedState() === target && mode.isPatron(attacker);
}

/** Who `patron` is called to war against now, or null. */
export function callToWarTargetFor(game: Game, patron: Player): Player | null {
  return modes.get(game)?.callToWarTarget(patron) ?? null;
}
