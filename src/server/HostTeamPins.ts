import {
  GameMode,
  GameType,
  HumansVsNations,
} from "@openfront/engine-api/game/GameTypes";
import { ClientID, GameConfig } from "@openfront/engine-api/Schemas";
import { isBossRaid } from "@openfront/engine-lib/game/BossRaid";
import {
  getMaxTeamSize,
  resolveTeamsList,
} from "@openfront/engine-lib/game/TeamAssignment";

// Host team picking. In a private, host-made team lobby the host can pin
// players to team slots before the start. A pin becomes the player's
// teamIndex in gameStartInfo, which assignTeams (engine-lib TeamAssignment)
// honours before it auto-balances everyone else into the remaining seats, so
// no new simulation rule is needed. The pins are server state, broadcast to
// the lobby as ClientInfo.teamIndex, which is what the lobby preview reads.

export type TeamPinError =
  | "team_pick.not_host"
  | "team_pick.not_allowed"
  | "team_pick.started"
  | "team_pick.unknown_player"
  | "team_pick.no_such_team"
  | "team_pick.team_full";

// What a pin is checked against: the lobby as the game would start now.
export interface TeamPinLobby {
  config: Pick<
    GameConfig,
    | "gameType"
    | "gameMode"
    | "playerTeams"
    | "rankedType"
    | "bossRaid"
    | "hordeNight"
  >;
  // Seated players' clientIDs (spectators take no seat).
  players: readonly ClientID[];
  // The nations the game will create: they take seats too.
  nationCount: number;
}

/** Whether the host of this lobby may pick teams. */
export function hostTeamPickingAllowed(config: TeamPinLobby["config"]) {
  return (
    config.gameType === GameType.Private &&
    config.gameMode === GameMode.Team &&
    config.rankedType === undefined &&
    config.playerTeams !== undefined &&
    config.playerTeams !== HumansVsNations &&
    !isBossRaid(config) &&
    // Horde Night puts every human and nation on one side.
    config.hordeNight?.enabled !== true
  );
}

/**
 * The team count and seats per team the game would start with, the same
 * numbers GameImpl hands assignTeams. Null when the lobby has no team picking.
 */
export function teamSlots(
  lobby: TeamPinLobby,
): { teams: number; maxTeamSize: number } | null {
  if (!hostTeamPickingAllowed(lobby.config)) return null;
  const playerTeams = lobby.config.playerTeams;
  if (playerTeams === undefined) return null;
  const total = lobby.players.length + lobby.nationCount;
  let teams: number;
  try {
    teams = resolveTeamsList(playerTeams, total).length;
  } catch {
    return null;
  }
  return { teams, maxTeamSize: getMaxTeamSize(total, teams) };
}

export class HostTeamPins {
  // Insertion order is pin order: when a lobby shrinks and a team holds more
  // pins than seats, the earliest pins keep theirs.
  private readonly pins = new Map<ClientID, number>();

  size(): number {
    return this.pins.size;
  }

  /**
   * Pins `target` to `teamIndex`, or back to auto balancing with null.
   * Returns why it was refused, or null when it was applied.
   */
  assign(
    lobby: TeamPinLobby,
    target: ClientID,
    teamIndex: number | null,
  ): TeamPinError | null {
    const slots = teamSlots(lobby);
    if (slots === null) return "team_pick.not_allowed";
    if (!lobby.players.includes(target)) return "team_pick.unknown_player";
    if (teamIndex === null) {
      this.pins.delete(target);
      return null;
    }
    if (!Number.isInteger(teamIndex) || teamIndex < 0) {
      return "team_pick.no_such_team";
    }
    if (teamIndex >= slots.teams) return "team_pick.no_such_team";
    let onTeam = 0;
    for (const [id, index] of this.effective(lobby)) {
      if (index === teamIndex && id !== target) onTeam++;
    }
    if (onTeam >= slots.maxTeamSize) return "team_pick.team_full";
    this.pins.delete(target);
    this.pins.set(target, teamIndex);
    return null;
  }

  /**
   * The pins that hold right now: seated players only, on teams that exist,
   * and no more per team than it has seats.
   */
  effective(lobby: TeamPinLobby): Map<ClientID, number> {
    const result = new Map<ClientID, number>();
    if (this.pins.size === 0) return result;
    const slots = teamSlots(lobby);
    if (slots === null) return result;
    const seated = new Set(lobby.players);
    const counts = new Map<number, number>();
    for (const [id, index] of this.pins) {
      if (!seated.has(id) || index >= slots.teams) continue;
      const n = counts.get(index) ?? 0;
      if (n >= slots.maxTeamSize) continue;
      counts.set(index, n + 1);
      result.set(id, index);
    }
    return result;
  }
}
