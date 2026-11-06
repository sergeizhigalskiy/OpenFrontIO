import {
  Difficulty,
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
// team. The Raiders win by bringing the Boss under 1% of the land for 30 s in
// a row (or to none), the Boss by surviving the timer or outlasting every
// Raider. The Boss scales with W, the weighted raiders the game started
// with, in which a human counts for far more than a nation. Nobody, human or
// nation, allies the Boss.

export { BOSS_RAID_NATION_BOSS };

export const BOSS_RAID_BOSS_TEAM: Team = "Boss";
export const BOSS_RAID_RAIDER_TEAM: Team = "Raiders";

/** The timer the Boss has to survive when the lobby sets none, in minutes. */
export const BOSS_RAID_DEFAULT_TIMER_MINUTES = 25;
/** The lobby's range for the Boss's timer, in minutes. */
export const BOSS_RAID_MIN_TIMER_MINUTES = 15;
export const BOSS_RAID_MAX_TIMER_MINUTES = 60;

// W, the weighted raiders, in hundredths (1.5 is 150): a human Raider counts
// 1.5, a nation Raider by its difficulty. Calibrate the human weight in
// playtests, aiming for the Boss winning about half the time.
/** A human Raider's weight: 1.5. */
export const BOSS_RAID_HUMAN_WEIGHT_HUNDREDTHS = 150;
/** A nation Raider's weight by difficulty: 0.25, 0.35, 0.5 and 0.6. */
export const BOSS_RAID_NATION_WEIGHT_HUNDREDTHS: Record<Difficulty, number> = {
  [Difficulty.Easy]: 25,
  [Difficulty.Medium]: 35,
  [Difficulty.Hard]: 50,
  [Difficulty.Impossible]: 60,
};

// The Boss's multipliers, as percents: 100 + PER_RAIDER * W.
/** Max troops x(1 + 0.6 W). */
export const BOSS_MAX_TROOPS_PERCENT_PER_RAIDER = 60;
/** Troop growth x(1 + 0.3 W). */
export const BOSS_TROOP_GROWTH_PERCENT_PER_RAIDER = 30;
/** Gold income x(1 + 0.3 W). */
export const BOSS_GOLD_INCOME_PERCENT_PER_RAIDER = 30;

/** `weight` is W in hundredths (bossRaidRaiderWeight). */
export function bossMaxTroopsPercent(weight: number): number {
  return 100 + (BOSS_MAX_TROOPS_PERCENT_PER_RAIDER * weight) / 100;
}
export function bossTroopGrowthPercent(weight: number): number {
  return 100 + (BOSS_TROOP_GROWTH_PERCENT_PER_RAIDER * weight) / 100;
}
export function bossGoldIncomePercent(weight: number): number {
  return 100 + (BOSS_GOLD_INCOME_PERCENT_PER_RAIDER * weight) / 100;
}

/**
 * Start shield: for the first 3 minutes after the spawn phase the Boss sends
 * at most 25% of its troops in one attack, so it can't swallow the map
 * before the Raiders get going.
 */
export const BOSS_RAID_SHIELD_TICKS = 3 * 60 * 10;
export const BOSS_RAID_SHIELD_ATTACK_PERCENT = 25;

/**
 * The most troops one Boss attack may hold `ticksSinceStart` ticks after the
 * spawn phase, when the Boss's troops at home plus that attack's are
 * `troops`. Infinity once the shield is down.
 */
export function bossShieldAttackCap(
  ticksSinceStart: number,
  troops: number,
): number {
  if (ticksSinceStart >= BOSS_RAID_SHIELD_TICKS) return Infinity;
  return Math.floor((troops * BOSS_RAID_SHIELD_ATTACK_PERCENT) / 100);
}

/** The Raiders win once the Boss holds under 1% of the land ... */
export const BOSS_RAID_LOW_LAND_PERCENT = 1;
/** ... for 30 s in a row. */
export const BOSS_RAID_LOW_LAND_TICKS = 30 * 10;

/**
 * The clock runs from the end of the start shield: everyone starts on a
 * few dozen tiles, far under 1% of the land.
 */
export const BOSS_RAID_LOW_LAND_FROM_TICKS = BOSS_RAID_SHIELD_TICKS;

/**
 * Whether the Boss, holding `bossTiles` of `landTiles` `ticksSinceStart`
 * ticks into the game, is under BOSS_RAID_LOW_LAND_PERCENT of the land with
 * the clock running.
 */
export function bossUnderLowLand(
  bossTiles: number,
  landTiles: number,
  ticksSinceStart: number,
): boolean {
  return (
    ticksSinceStart >= BOSS_RAID_LOW_LAND_FROM_TICKS &&
    bossTiles * 100 < landTiles * BOSS_RAID_LOW_LAND_PERCENT
  );
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

/** Minutes the Boss has to survive: the lobby's, kept within its range. */
export function bossRaidTimerMinutes(
  config: Pick<GameConfig, "maxTimerValue">,
): number {
  const minutes = config.maxTimerValue ?? BOSS_RAID_DEFAULT_TIMER_MINUTES;
  return Math.max(
    BOSS_RAID_MIN_TIMER_MINUTES,
    Math.min(BOSS_RAID_MAX_TIMER_MINUTES, minutes),
  );
}

/**
 * The config with the Boss Raid timer filled in and kept in range, so the
 * HUD's end timer and the win check read the same value. Any other config
 * comes back unchanged.
 */
export function withBossRaidDefaults(config: GameConfig): GameConfig {
  if (!isBossRaid(config)) return config;
  const minutes = bossRaidTimerMinutes(config);
  if (config.maxTimerValue === minutes) return config;
  return { ...config, maxTimerValue: minutes };
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
 * the other a Raider. Nobody, human or nation, allies across that line.
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

/**
 * W in hundredths: 1.5 per human on the Raiders team, plus each nation
 * Raider's weight at `nationDifficulty` (the lobby's). Tribes don't count.
 */
export function bossRaidRaiderWeight(
  players: Iterable<{ team(): Team | null; type(): PlayerType }>,
  nationDifficulty: Difficulty,
): number {
  let weight = 0;
  for (const p of players) {
    if (p.team() !== BOSS_RAID_RAIDER_TEAM) continue;
    if (p.type() === PlayerType.Human) {
      weight += BOSS_RAID_HUMAN_WEIGHT_HUNDREDTHS;
    } else if (p.type() === PlayerType.Nation) {
      weight += BOSS_RAID_NATION_WEIGHT_HUNDREDTHS[nationDifficulty];
    }
  }
  return weight;
}

export type BossRaidWinner = "boss" | "raiders" | null;

/**
 * Who has won so far: the Raiders once the Boss holds no land, or has held
 * under 1% of it for BOSS_RAID_LOW_LAND_TICKS in a row (`lowLandTicks`); the
 * Boss once the timer runs out or no Raider is left.
 */
export function bossRaidWinner(state: {
  bossAlive: boolean;
  lowLandTicks: number;
  raidersAlive: boolean;
  elapsedSeconds: number;
  timerMinutes: number;
}): BossRaidWinner {
  if (!state.bossAlive) return "raiders";
  if (state.lowLandTicks >= BOSS_RAID_LOW_LAND_TICKS) return "raiders";
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
