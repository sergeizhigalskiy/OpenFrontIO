import { GameMode } from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { PROTECTED_STATE_MODE_NAME } from "./ProtectedState";

/**
 * Lobby modes that each set the sides or the win rule their own way, so at
 * most one may be on at a time:
 *
 * - Boss Raid (BossRaid.ts) builds its own two teams and has its own win
 *   check.
 * - Horde Night (HordeNight.ts) puts every human and nation on one side and
 *   replaces the win check.
 * - The plague (Plague.ts) adds its own win and loss, which Horde Night's
 *   check would skip and Boss Raid's would contradict.
 * - The Protected State (ProtectedState.ts) has the strongest nations guard
 *   one small nation, which Boss Raid's and Horde Night's sides would split
 *   and the plague's survival rules would override.
 *
 * The lobby modals turn the others off when one is switched on, and the
 * server refuses a config that has two (create_game, the admin bot's
 * create_game and update_game_config).
 */
export type ExclusiveMode =
  | "bossRaid"
  | "hordeNight"
  | "plague"
  | "protectedState";

type ModeConfig = Partial<
  Pick<
    GameConfig,
    "gameMode" | "bossRaid" | "hordeNight" | "plague" | "protectedState"
  >
>;

/**
 * Translation keys of the modes' names, as the lobby labels them. The
 * Protected State's takes its name as `{mode}` (protectedStateTextParams).
 */
export const EXCLUSIVE_MODE_LABEL_KEYS: Record<ExclusiveMode, string> = {
  bossRaid: "game_mode.boss_raid",
  hordeNight: "horde_night.title",
  plague: "game_settings.plague",
  protectedState: "game_settings.protected_state",
};

/**
 * Translation keys of each mode's one-line win rule, as the lobby shows it.
 * The Protected State's takes `{mode}` too.
 */
export const EXCLUSIVE_MODE_RULE_KEYS: Record<ExclusiveMode, string> = {
  bossRaid: "boss_raid.rules",
  hordeNight: "horde_night.rules",
  plague: "plague.rules",
  protectedState: "protected_state.rules",
};

/** The win rule of the exclusive mode `config` turns on, or null. */
export function modeWinRuleKey(config: ModeConfig): string | null {
  const [mode] = exclusiveModesOn(config);
  return mode === undefined ? null : EXCLUSIVE_MODE_RULE_KEYS[mode];
}

const MODE_NAMES: Record<ExclusiveMode, string> = {
  bossRaid: "Boss Raid",
  hordeNight: "Horde Night",
  plague: "the zombie plague",
  protectedState: PROTECTED_STATE_MODE_NAME,
};

/** The exclusive modes `config` turns on, in a fixed order. */
export function exclusiveModesOn(config: ModeConfig): ExclusiveMode[] {
  const on: ExclusiveMode[] = [];
  // Boss Raid only counts in a Team game, like BossRaid.bossRaidOf.
  if (
    config.gameMode === GameMode.Team &&
    config.bossRaid !== undefined &&
    config.bossRaid !== null
  ) {
    on.push("bossRaid");
  }
  if (config.hordeNight?.enabled === true) on.push("hordeNight");
  if (config.plague === true) on.push("plague");
  if (config.protectedState === true) on.push("protectedState");
  return on;
}

/**
 * Why the server refuses `config`, or null when at most one exclusive mode
 * is on.
 */
export function exclusiveModeError(config: ModeConfig): string | null {
  const on = exclusiveModesOn(config);
  if (on.length < 2) return null;
  return `${MODE_NAMES[on[0]]} and ${MODE_NAMES[on[1]]} can't be played together`;
}
