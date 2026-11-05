import type { Winner } from "@openfront/engine-api/Schemas";
import {
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
} from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_PLAYER_ID,
  INFECTED_TEAM,
} from "@openfront/engine-lib/game/Plague";
import { getTranslatedPlayerTeamLabel, translateText } from "../../Utils";
import type { GameView } from "../../view";

/**
 * The win and lose screens of the survival lobby modes, named after the mode
 * (WinCheckExecution's Horde Night and plague branches). Null when neither
 * mode decided the game, so the win modal shows its usual title.
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
      return {
        title: translateText("horde_night.defenders_won"),
        isWin: me?.team() === HORDE_DEFENDERS_TEAM,
      };
    }
    if (winner[1] === HORDE_TEAM) {
      return { title: translateText("horde_night.horde_won"), isWin: false };
    }
  }

  if (config.plague === true) {
    if (winner[0] === "team" && winner[1] === INFECTED_TEAM) {
      return { title: translateText("plague.consumed"), isWin: false };
    }
    // A plague game can also end the usual way while The Infected lives.
    const cured =
      game.hasPlayer(INFECTED_PLAYER_ID) &&
      !game.player(INFECTED_PLAYER_ID).isAlive();
    if (!cured) return null;
    if (winner[0] === "team") {
      const isWin = me !== null && me.team() === winner[1];
      return {
        title: isWin
          ? translateText("plague.cured_your_team")
          : translateText("plague.cured_other", {
              name: getTranslatedPlayerTeamLabel(winner[1]),
            }),
        isWin,
      };
    }
    if (winner[0] === "nation") {
      return {
        title: translateText("plague.cured_other", { name: winner[1] }),
        isWin: false,
      };
    }
    const isWin = me !== null && me.clientID() === winner[1];
    const name = game.playerByClientID(winner[1])?.displayName() ?? "";
    return {
      title: isWin
        ? translateText("plague.cured_you")
        : translateText("plague.cured_other", { name }),
      isWin,
    };
  }
  return null;
}
