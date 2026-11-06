import type { Winner } from "@openfront/engine-api/Schemas";
import {
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
} from "@openfront/engine-lib/game/HordeNight";
import { INFECTED_TEAM } from "@openfront/engine-lib/game/Plague";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * The win and lose screens of the survival lobby modes, named after the mode
 * (WinCheckExecution's Horde Night and plague branches). Null when neither
 * mode decided the game, so the win modal shows its usual title: a plague
 * game the Infected didn't consume ends the usual way.
 */
export function survivalModeEnding(
  game: GameView,
  winner: Winner,
): { title: string; isWin: boolean } | null {
  if (winner === undefined) return null;
  const config = game.config().gameConfig();
  const me = game.myPlayer();

  if (config.hordeNight?.enabled === true && winner[0] === "team") {
    if (winner[1] === HORDE_DEFENDERS_TEAM) {
      const narrow = game.cataclysm().horde?.outcome === "narrow";
      return {
        title: translateText(
          narrow ? "horde_night.narrow_win" : "horde_night.defenders_won",
        ),
        isWin: me?.team() === HORDE_DEFENDERS_TEAM,
      };
    }
    if (winner[1] === HORDE_TEAM) {
      return { title: translateText("horde_night.horde_won"), isWin: false };
    }
  }

  if (
    config.plague === true &&
    winner[0] === "team" &&
    winner[1] === INFECTED_TEAM
  ) {
    return { title: translateText("plague.consumed"), isWin: false };
  }
  return null;
}
