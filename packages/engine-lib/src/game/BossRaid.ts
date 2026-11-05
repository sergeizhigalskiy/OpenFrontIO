import {
  GameMode,
  PlayerInfo,
  PlayerType,
  Team,
} from "@openfront/engine-api/game/GameTypes";
import {
  BOSS_RAID_NATION_BOSS,
  BossRaidConfig,
  ClientID,
  GameConfig,
} from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "../PseudoRandom";
import { simpleHash } from "../Util";

// Boss Raid: everyone against one Boss. The Boss is a volunteer human or an
// Impossible nation; every other player and nation is a Raider, all on one
// team. Raiders win by eliminating the Boss, the Boss wins by surviving the
// timer. The Boss scales with N, the number of raiders the game started with.

export { BOSS_RAID_NATION_BOSS };

export const BOSS_RAID_BOSS_TEAM: Team = "Boss";
export const BOSS_RAID_RAIDER_TEAM: Team = "Raiders";

/** The timer the Boss has to survive when the lobby sets none, in minutes. */
export const BOSS_RAID_DEFAULT_TIMER_MINUTES = 25;

// The Boss's multipliers, as integer percents: 100 + PER_RAIDER * N.
/** Max troops x(1 + 0.6 N). */
export const BOSS_MAX_TROOPS_PERCENT_PER_RAIDER = 60;
/** Troop growth x(1 + 0.3 N). */
export const BOSS_TROOP_GROWTH_PERCENT_PER_RAIDER = 30;
/** Gold income x(1 + 0.3 N). */
export const BOSS_GOLD_INCOME_PERCENT_PER_RAIDER = 30;

export function bossMaxTroopsPercent(raiders: number): number {
  return 100 + BOSS_MAX_TROOPS_PERCENT_PER_RAIDER * raiders;
}
export function bossTroopGrowthPercent(raiders: number): number {
  return 100 + BOSS_TROOP_GROWTH_PERCENT_PER_RAIDER * raiders;
}
export function bossGoldIncomePercent(raiders: number): number {
  return 100 + BOSS_GOLD_INCOME_PERCENT_PER_RAIDER * raiders;
}

/** The game's Boss Raid settings, or null when it isn't a Boss Raid. */
export function bossRaidOf(
  config: Pick<GameConfig, "bossRaid" | "gameMode">,
): BossRaidConfig | null {
  if (config.gameMode !== GameMode.Team) return null;
  return config.bossRaid ?? null;
}

export function isBossRaid(
  config: Pick<GameConfig, "bossRaid" | "gameMode">,
): boolean {
  return bossRaidOf(config) !== null;
}

/** Minutes the Boss has to survive. */
export function bossRaidTimerMinutes(
  config: Pick<GameConfig, "maxTimerValue">,
): number {
  return config.maxTimerValue ?? BOSS_RAID_DEFAULT_TIMER_MINUTES;
}

/**
 * The config with the Boss Raid timer filled in, so the HUD's end timer and
 * the win check read the same value. Any other config comes back unchanged.
 */
export function withBossRaidDefaults(config: GameConfig): GameConfig {
  if (!isBossRaid(config) || typeof config.maxTimerValue === "number") {
    return config;
  }
  return { ...config, maxTimerValue: BOSS_RAID_DEFAULT_TIMER_MINUTES };
}

/** Whether `player` is the Boss: the only player on the Boss team. */
export function isBossRaidBoss(
  config: Pick<GameConfig, "bossRaid" | "gameMode">,
  player: { team(): Team | null },
): boolean {
  return isBossRaid(config) && player.team() === BOSS_RAID_BOSS_TEAM;
}

/**
 * Whether `a` and `b` stand on opposite sides of a Boss Raid: one the Boss,
 * the other a Raider. Nations never ally across that line, so the AI keeps it
 * everyone against the Boss; humans may ally whoever they like.
 */
export function acrossBossLine(
  config: Pick<GameConfig, "bossRaid" | "gameMode">,
  a: { team(): Team | null },
  b: { team(): Team | null },
): boolean {
  if (!isBossRaid(config)) return false;
  const sides = [a.team(), b.team()];
  return (
    sides.includes(BOSS_RAID_BOSS_TEAM) && sides.includes(BOSS_RAID_RAIDER_TEAM)
  );
}

/**
 * Index into `humans` of the human Boss, or null when a nation is the Boss.
 * The volunteer if they are playing; otherwise a nation; with no nations,
 * the first human (a lobby the validation below would have refused).
 */
export function bossRaidHumanBossIndex(
  boss: BossRaidConfig,
  humans: readonly Pick<PlayerInfo, "clientID">[],
  nationCount: number,
): number | null {
  if (boss.boss !== BOSS_RAID_NATION_BOSS) {
    const i = humans.findIndex((h) => h.clientID === boss.boss);
    if (i !== -1) return i;
  }
  if (nationCount > 0) return null;
  return humans.length > 0 ? 0 : null;
}

/** The Boss among the game's players, picked by the rule above. */
export function pickBossRaidBoss(
  boss: BossRaidConfig,
  humans: readonly PlayerInfo[],
  nations: readonly PlayerInfo[],
): PlayerInfo | null {
  const human = bossRaidHumanBossIndex(boss, humans, nations.length);
  if (human !== null) return humans[human];
  if (nations.length === 0) return null;
  // Nation ids come from the game's seeded PRNG, so the pick differs between
  // games but is the same on every client.
  const random = new PseudoRandom(simpleHash(nations[0].id));
  return nations[random.nextInt(0, nations.length)];
}

/**
 * Every player's team, humans first and then nations, each in the order
 * given: the Boss alone on the Boss team, everyone else a Raider.
 */
export function assignBossRaidTeams(
  boss: BossRaidConfig,
  humans: readonly PlayerInfo[],
  nations: readonly PlayerInfo[],
): Map<PlayerInfo, Team> {
  const picked = pickBossRaidBoss(boss, humans, nations);
  const result = new Map<PlayerInfo, Team>();
  for (const p of [...humans, ...nations]) {
    result.set(p, p === picked ? BOSS_RAID_BOSS_TEAM : BOSS_RAID_RAIDER_TEAM);
  }
  return result;
}

/** The team of each human, in `humans` order (game records, previews). */
export function bossRaidHumanTeams(
  boss: BossRaidConfig,
  humans: readonly Pick<PlayerInfo, "clientID">[],
  nationCount: number,
): Team[] {
  const bossIndex = bossRaidHumanBossIndex(boss, humans, nationCount);
  return humans.map((_, i) =>
    i === bossIndex ? BOSS_RAID_BOSS_TEAM : BOSS_RAID_RAIDER_TEAM,
  );
}

/** N: players on the Raiders team, tribes excluded. */
export function countBossRaidRaiders(
  players: Iterable<{ team(): Team | null; type(): PlayerType }>,
): number {
  let n = 0;
  for (const p of players) {
    if (p.type() !== PlayerType.Bot && p.team() === BOSS_RAID_RAIDER_TEAM) n++;
  }
  return n;
}

export type BossRaidWinner = "boss" | "raiders" | null;

/**
 * Who has won so far: the Raiders once the Boss is eliminated, the Boss once
 * the timer runs out or no Raider is left.
 */
export function bossRaidWinner(state: {
  bossAlive: boolean;
  raidersAlive: boolean;
  elapsedSeconds: number;
  timerMinutes: number;
}): BossRaidWinner {
  if (!state.bossAlive) return "raiders";
  if (!state.raidersAlive) return "boss";
  if (state.elapsedSeconds >= state.timerMinutes * 60) return "boss";
  return null;
}

export type BossRaidConfigError =
  | "boss_raid.needs_team_mode"
  | "boss_raid.needs_nation"
  | "boss_raid.boss_not_in_lobby"
  | "boss_raid.needs_raiders";

/**
 * Why a lobby can't start this Boss Raid, or null when it can. `players` are
 * the clientIDs of the seated players, `nationCount` the nations the game
 * will create.
 */
export function bossRaidConfigError(
  config: Pick<GameConfig, "bossRaid" | "gameMode">,
  players: readonly ClientID[],
  nationCount: number,
): BossRaidConfigError | null {
  const boss = config.bossRaid;
  if (boss === undefined || boss === null) return null;
  if (config.gameMode !== GameMode.Team) return "boss_raid.needs_team_mode";
  const humanBoss = boss.boss !== BOSS_RAID_NATION_BOSS;
  if (!humanBoss && nationCount === 0) return "boss_raid.needs_nation";
  if (humanBoss && !players.includes(boss.boss)) {
    return "boss_raid.boss_not_in_lobby";
  }
  if (players.length + nationCount - 1 < 1) return "boss_raid.needs_raiders";
  return null;
}
