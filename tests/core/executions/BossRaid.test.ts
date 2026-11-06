import {
  Difficulty,
  GameMode,
  GameType,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  BossRaidConfigSchema,
  GameConfig,
  GameConfigSchema,
} from "@openfront/engine-api/Schemas";
import {
  acrossBossLine,
  BOSS_RAID_BOSS_TEAM,
  BOSS_RAID_DEFAULT_TIMER_MINUTES,
  BOSS_RAID_LOW_LAND_TICKS,
  BOSS_RAID_MAX_TIMER_MINUTES,
  BOSS_RAID_MIN_TIMER_MINUTES,
  BOSS_RAID_NATION_BOSS,
  BOSS_RAID_RAIDER_TEAM,
  BOSS_RAID_SHIELD_TICKS,
  bossGoldIncomePercent,
  bossMaxTroopsPercent,
  bossRaidConfigError,
  bossRaidHumanTeams,
  bossRaidRaiderWeight,
  bossRaidTimerMinutes,
  bossRaidWinner,
  bossShieldAttackCap,
  bossTroopGrowthPercent,
  bossUnderLowLand,
  pickBossRaidBoss,
  withBossRaidDefaults,
} from "@openfront/engine-lib/game/BossRaid";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AllianceRequestExecution } from "@openfront/engine/execution/alliance/AllianceRequestExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  BOSS_STRATEGY_SLOT,
  bossFor,
  withBossStrategy,
} from "@openfront/engine/execution/nation/BossRaidTargeting";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { TestConfig } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

const MAP = "big_plains";

function human(name: string, clientID: string, creator = false): PlayerInfo {
  return new PlayerInfo(name, PlayerType.Human, clientID, name, creator);
}

function nation(name: string): Nation {
  return new Nation(
    undefined,
    new PlayerInfo(name, PlayerType.Nation, null, name),
  );
}

async function bossRaidGame(opts: {
  humans: PlayerInfo[];
  nations: string[];
  boss: string;
  config?: Partial<GameConfig>;
}): Promise<Game> {
  return setup(
    MAP,
    {
      gameMode: GameMode.Team,
      playerTeams: 2,
      bossRaid: { boss: opts.boss },
      ...opts.config,
    },
    opts.humans,
    undefined,
    TestConfig,
    true,
    opts.nations.map(nation),
  );
}

// Splits the map's land in vertical bands, one per player, so neighbours
// share a border.
function giveBands(game: Game, players: Player[]): void {
  const width = game.width();
  const band = Math.floor(width / players.length);
  game.map().forEachTile((tile) => {
    if (!game.map().isLand(tile)) return;
    const i = Math.min(players.length - 1, Math.floor(game.x(tile) / band));
    players[i].conquer(tile);
  });
}

function bossOf(game: Game): Player {
  const boss = game.allPlayers().find((p) => p.team() === BOSS_RAID_BOSS_TEAM);
  if (boss === undefined) throw new Error("no boss");
  return boss;
}

describe("Boss Raid scaling", () => {
  // W in hundredths: 1 + 0.6 W for the cap, 1 + 0.3 W for growth and gold.
  test.each([
    [0, 100, 100, 100],
    [25, 115, 107.5, 107.5],
    [150, 190, 145, 145],
    [750, 550, 325, 325],
  ])(
    "W=%i/100: max troops %i%%, growth %d%%, gold %d%%",
    (w, troops, growth, gold) => {
      expect(bossMaxTroopsPercent(w)).toBe(troops);
      expect(bossTroopGrowthPercent(w)).toBe(growth);
      expect(bossGoldIncomePercent(w)).toBe(gold);
    },
  );

  test("W: 1.5 per human, a nation by difficulty, tribes and the Boss not at all", () => {
    const p = (team: string, type: PlayerType) => ({
      team: () => team,
      type: () => type,
    });
    const raider = (type: PlayerType) => p(BOSS_RAID_RAIDER_TEAM, type);
    const players = [
      raider(PlayerType.Human),
      ...Array.from({ length: 12 }, () => raider(PlayerType.Nation)),
      raider(PlayerType.Bot),
      p(BOSS_RAID_BOSS_TEAM, PlayerType.Nation),
    ];
    // 1 human and 12 Hard nations: W = 7.5, a 5.5x cap (8.2x when every
    // raider counted 1).
    expect(bossRaidRaiderWeight(players, Difficulty.Hard)).toBe(750);
    expect(bossMaxTroopsPercent(750)).toBe(550);
    expect(bossRaidRaiderWeight(players, Difficulty.Easy)).toBe(150 + 12 * 25);
    expect(bossRaidRaiderWeight(players, Difficulty.Medium)).toBe(
      150 + 12 * 35,
    );
    expect(bossRaidRaiderWeight(players, Difficulty.Impossible)).toBe(
      150 + 12 * 60,
    );
  });

  test("the Boss's caps and income scale with W; a Raider's don't", async () => {
    const game = await bossRaidGame({
      humans: [human("boss", "bossaaaa"), human("raider", "raider01")],
      nations: ["n1", "n2", "n3"],
      boss: "bossaaaa",
    });
    const boss = game.player("boss");
    const raider = game.player("raider");
    expect(boss.team()).toBe(BOSS_RAID_BOSS_TEAM);
    // A human and three Medium nations.
    const w = 150 + 3 * 35;
    expect(game.config().bossRaidRaiderWeight()).toBe(w);
    giveBands(game, [boss, raider]);
    // Same territory, so the only difference is the Boss multiplier.
    const tiles = Math.min(boss.numTilesOwned(), raider.numTilesOwned());
    const plain = await setup(MAP, {}, [human("solo", "solo0000")]);
    const solo = plain.player("solo");
    let n = 0;
    plain.map().forEachTile((t) => {
      if (n < tiles && plain.map().isLand(t)) {
        solo.conquer(t);
        n++;
      }
    });
    while (boss.numTilesOwned() > tiles) {
      boss.relinquish(boss.tiles().values().next().value!);
    }
    while (raider.numTilesOwned() > tiles) {
      raider.relinquish(raider.tiles().values().next().value!);
    }
    const config = game.config();
    const base = plain.config().maxTroops(solo);
    expect(config.maxTroops(raider)).toBe(base);
    expect(config.maxTroops(boss)).toBe((base * bossMaxTroopsPercent(w)) / 100);

    boss.setTroops(10_000);
    raider.setTroops(10_000);
    solo.setTroops(10_000);
    expect(config.troopIncreaseRate(raider)).toBe(
      plain.config().troopIncreaseRate(solo),
    );
    expect(config.troopIncreaseRate(boss)).toBeGreaterThan(
      config.troopIncreaseRate(raider) * 1.7,
    );

    expect(config.goldAdditionRate(raider)).toBe(100n);
    expect(config.goldAdditionRate(boss)).toBe(
      BigInt(Math.floor((100 * bossGoldIncomePercent(w)) / 100)),
    );
  });

  test("off by default: a Team game's players are untouched", async () => {
    const game = await setup(MAP, { gameMode: GameMode.Team, playerTeams: 2 }, [
      human("a", "aaaaaaaa"),
      human("b", "bbbbbbbb"),
    ]);
    expect(game.config().bossRaidRaiderWeight()).toBe(0);
    expect(game.config().disableAlliances()).toBe(false);
    for (const p of game.allPlayers()) {
      expect(p.team()).not.toBe(BOSS_RAID_BOSS_TEAM);
    }
  });
});

describe("Boss Raid teams", () => {
  test("every raider, human or nation, is on one friendly team", async () => {
    const game = await bossRaidGame({
      humans: [
        human("host", "hosthost", true),
        human("boss", "bossaaaa"),
        human("r2", "raider02"),
      ],
      nations: ["n1", "n2"],
      boss: "bossaaaa",
    });
    const boss = game.player("boss");
    const raiders = game
      .allPlayers()
      .filter((p) => p.team() === BOSS_RAID_RAIDER_TEAM);
    expect(raiders.map((p) => p.name()).sort()).toEqual([
      "host",
      "n1",
      "n2",
      "r2",
    ]);
    for (const a of raiders) {
      for (const b of raiders) {
        if (a !== b) expect(a.isFriendly(b)).toBe(true);
      }
      expect(a.isFriendly(boss)).toBe(false);
      expect(boss.isFriendly(a)).toBe(false);
    }
    // Alliances follow the lobby's setting, as in any game.
    expect(game.config().disableAlliances()).toBe(false);
    expect(game.config().bossRaidRaiderWeight()).toBe(2 * 150 + 2 * 35);
    const noAlliances = await bossRaidGame({
      humans: [human("boss", "bossaaaa"), human("r1", "raider01")],
      nations: [],
      boss: "bossaaaa",
      config: { customAllianceDuration: 0 },
    });
    expect(noAlliances.config().disableAlliances()).toBe(true);
  });

  test("a volunteer who isn't playing falls back to a nation Boss", () => {
    const humans = [human("a", "aaaaaaaa"), human("b", "bbbbbbbb")];
    const nations = [nation("n1").playerInfo, nation("n2").playerInfo];
    const picked = pickBossRaidBoss({ boss: "gone0000" }, humans, nations);
    expect(picked?.playerType).toBe(PlayerType.Nation);
    expect(bossRaidHumanTeams({ boss: "bbbbbbbb" }, humans, 2)).toEqual([
      BOSS_RAID_RAIDER_TEAM,
      BOSS_RAID_BOSS_TEAM,
    ]);
    expect(
      bossRaidHumanTeams({ boss: BOSS_RAID_NATION_BOSS }, humans, 2),
    ).toEqual([BOSS_RAID_RAIDER_TEAM, BOSS_RAID_RAIDER_TEAM]);
  });
});

describe("Boss Raid singleplayer", () => {
  test("you raid alongside the nations against an Impossible nation Boss", async () => {
    const game = await bossRaidGame({
      humans: [human("me", "meeeeeee", true)],
      nations: ["n1", "n2", "n3", "n4"],
      boss: BOSS_RAID_NATION_BOSS,
      config: { gameType: GameType.Singleplayer, difficulty: Difficulty.Easy },
    });
    const me = game.player("me");
    expect(me.team()).toBe(BOSS_RAID_RAIDER_TEAM);
    const boss = bossOf(game);
    expect(boss.type()).toBe(PlayerType.Nation);
    expect(game.config().difficultyFor(boss)).toBe(Difficulty.Impossible);
    const raiderNations = game
      .allPlayers()
      .filter((p) => p.type() === PlayerType.Nation && p !== boss);
    expect(raiderNations).toHaveLength(3);
    for (const n of raiderNations) {
      expect(n.team()).toBe(BOSS_RAID_RAIDER_TEAM);
      expect(game.config().difficultyFor(n)).toBe(Difficulty.Easy);
    }
    expect(game.config().bossRaidRaiderWeight()).toBe(150 + 3 * 25);
    // The lobby left the timer unset, so the Boss Raid default applies.
    expect(game.config().gameConfig().maxTimerValue).toBe(
      BOSS_RAID_DEFAULT_TIMER_MINUTES,
    );
  });

  test("the nation Boss is picked the same way every time", async () => {
    const make = () =>
      bossRaidGame({
        humans: [human("me", "meeeeeee", true)],
        nations: ["n1", "n2", "n3", "n4"],
        boss: BOSS_RAID_NATION_BOSS,
      });
    expect(bossOf(await make()).name()).toBe(bossOf(await make()).name());
  });
});

describe("Boss Raid win conditions", () => {
  const alive = { bossAlive: true, raidersAlive: true, lowLandTicks: 0 };
  test.each([
    [{ ...alive, bossAlive: false, elapsedSeconds: 10 }, "raiders"],
    [{ ...alive, elapsedSeconds: 10 }, null],
    [{ ...alive, lowLandTicks: 299, elapsedSeconds: 10 }, null],
    [{ ...alive, lowLandTicks: 300, elapsedSeconds: 10 }, "raiders"],
    [{ ...alive, elapsedSeconds: 1500 }, "boss"],
    [{ ...alive, raidersAlive: false, elapsedSeconds: 10 }, "boss"],
  ] as const)("%o -> %s", (state, winner) => {
    expect(bossRaidWinner({ ...state, timerMinutes: 25 })).toBe(winner);
  });

  test("under 1% of the land, for 30 s in a row, once the start shield is down", () => {
    expect(BOSS_RAID_LOW_LAND_TICKS).toBe(300);
    expect(bossUnderLowLand(99, 10_000, 1800)).toBe(true);
    expect(bossUnderLowLand(100, 10_000, 1800)).toBe(false);
    // Everyone starts on a few tiles: no clock in the first 3 minutes.
    expect(bossUnderLowLand(99, 10_000, 1799)).toBe(false);
  });

  test("the timer: 25 minutes unless set, kept between 15 and 60", () => {
    expect(BOSS_RAID_MIN_TIMER_MINUTES).toBe(15);
    expect(BOSS_RAID_MAX_TIMER_MINUTES).toBe(60);
    expect(bossRaidTimerMinutes({})).toBe(25);
    expect(bossRaidTimerMinutes({ maxTimerValue: 5 })).toBe(15);
    expect(bossRaidTimerMinutes({ maxTimerValue: 40 })).toBe(40);
    expect(bossRaidTimerMinutes({ maxTimerValue: 90 })).toBe(60);
    const raid = {
      gameMode: GameMode.Team,
      bossRaid: { boss: "nation" },
    } as GameConfig;
    expect(
      withBossRaidDefaults({ ...raid, maxTimerValue: 90 }).maxTimerValue,
    ).toBe(60);
    expect(withBossRaidDefaults(raid).maxTimerValue).toBe(25);
  });

  async function raid() {
    const game = await bossRaidGame({
      humans: [human("boss", "bossaaaa"), human("raider", "raider01")],
      nations: [],
      boss: "bossaaaa",
    });
    const boss = game.player("boss");
    const raider = game.player("raider");
    giveBands(game, [boss, raider]);
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 20);
    expect(game.getWinner()).toBeNull();
    return { game, boss, raider };
  }

  test("the Raiders win by eliminating the Boss", async () => {
    const { game, boss } = await raid();
    for (const tile of [...boss.tiles()]) boss.relinquish(tile);
    executeTicks(game, 10);
    expect(game.getWinner()).toBe(BOSS_RAID_RAIDER_TEAM);
  });

  test("the Boss wins once every Raider is eliminated", async () => {
    const { game, raider } = await raid();
    for (const tile of [...raider.tiles()]) raider.relinquish(tile);
    executeTicks(game, 10);
    expect(game.getWinner()).toBe(BOSS_RAID_BOSS_TEAM);
  });

  test("the Raiders win once the Boss holds under 1% of the land for 30 s", async () => {
    const { game, boss, raider } = await raid();
    const keep = Math.floor(game.numLandTiles() / 100) - 1;
    const shrink = () => {
      for (const tile of [...boss.tiles()].slice(keep)) boss.relinquish(tile);
    };
    shrink();
    // Not during the start shield.
    executeTicks(game, 400);
    expect(game.getWinner()).toBeNull();
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(BOSS_RAID_SHIELD_TICKS);
    executeTicks(game, 290);
    expect(game.getWinner()).toBeNull();
    // Back over 1% for a moment: the 30 s start again.
    for (const tile of [...raider.tiles()].slice(0, 10)) boss.conquer(tile);
    executeTicks(game, 20);
    shrink();
    executeTicks(game, 290);
    expect(game.getWinner()).toBeNull();
    executeTicks(game, 30);
    expect(boss.isAlive()).toBe(true);
    expect(game.getWinner()).toBe(BOSS_RAID_RAIDER_TEAM);
  });

  test("the Boss wins by surviving the timer, whatever the tile share", async () => {
    const { game, raider } = await raid();
    // The Raiders hold almost everything: an ordinary Team game would be won.
    expect(raider.numTilesOwned()).toBeGreaterThan(0);
    vi.spyOn(game, "elapsedGameSeconds").mockReturnValue(
      BOSS_RAID_DEFAULT_TIMER_MINUTES * 60,
    );
    executeTicks(game, 10);
    expect(game.getWinner()).toBe(BOSS_RAID_BOSS_TEAM);
  });
});

describe("Boss Raid lobby validation", () => {
  const team = { gameMode: GameMode.Team };
  test.each([
    [{ ...team, bossRaid: undefined }, ["aaaaaaaa"], 0, null],
    [{ ...team, bossRaid: { boss: "nation" } }, ["aaaaaaaa"], 3, null],
    [
      { ...team, bossRaid: { boss: "nation" } },
      ["aaaaaaaa"],
      0,
      "boss_raid.needs_nation",
    ],
    [
      { ...team, bossRaid: { boss: "bbbbbbbb" } },
      ["aaaaaaaa"],
      2,
      "boss_raid.boss_not_in_lobby",
    ],
    [
      { ...team, bossRaid: { boss: "aaaaaaaa" } },
      ["aaaaaaaa"],
      0,
      "boss_raid.needs_raiders",
    ],
    [
      { ...team, bossRaid: { boss: "aaaaaaaa" } },
      ["aaaaaaaa", "bbbbbbbb"],
      0,
      null,
    ],
    [
      { gameMode: GameMode.FFA, bossRaid: { boss: "nation" } },
      ["aaaaaaaa"],
      3,
      "boss_raid.needs_team_mode",
    ],
  ] as const)(
    "%o with %o and %i nations -> %s",
    (config, players, nations, error) => {
      expect(bossRaidConfigError(config, players, nations)).toBe(error);
    },
  );

  test("the wire schema takes a nation or a clientID, nothing else", () => {
    expect(BossRaidConfigSchema.safeParse({ boss: "nation" }).success).toBe(
      true,
    );
    expect(BossRaidConfigSchema.safeParse({ boss: "aB3dEf7h" }).success).toBe(
      true,
    );
    expect(BossRaidConfigSchema.safeParse({ boss: "" }).success).toBe(false);
    expect(BossRaidConfigSchema.safeParse({ boss: "nations" }).success).toBe(
      false,
    );
    expect(BossRaidConfigSchema.safeParse({ boss: "a;b" }).success).toBe(false);
    const base = {
      gameMap: "World",
      difficulty: Difficulty.Medium,
      donateGold: true,
      donateTroops: true,
      gameType: GameType.Private,
      gameMode: GameMode.Team,
      gameMapSize: "Normal",
      nations: "default",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    };
    expect(
      GameConfigSchema.safeParse({ ...base, bossRaid: null }).success,
    ).toBe(true);
    expect(
      GameConfigSchema.safeParse({ ...base, bossRaid: { boss: "nation" } })
        .success,
    ).toBe(true);
  });
});

describe("Boss Raid nation AI", () => {
  test("the Boss strategy's slot rises with difficulty", () => {
    const order = ["a", "b", "c", "d", "e"];
    expect(
      withBossStrategy(order, "boss", true, Difficulty.Impossible)[0],
    ).toBe("boss");
    expect(withBossStrategy(order, "boss", true, Difficulty.Hard)[1]).toBe(
      "boss",
    );
    expect(withBossStrategy(order, "boss", true, Difficulty.Medium)[2]).toBe(
      "boss",
    );
    expect(withBossStrategy(order, "boss", true, Difficulty.Easy)[3]).toBe(
      "boss",
    );
    expect(withBossStrategy(order, "boss", false, Difficulty.Impossible)).toBe(
      order,
    );
  });

  test.each([
    Difficulty.Easy,
    Difficulty.Medium,
    Difficulty.Hard,
    Difficulty.Impossible,
  ])(
    "%s: a nation Raider attacks the bordering Boss, not its teammate",
    async (difficulty) => {
      const game = await bossRaidGame({
        humans: [human("boss", "bossaaaa"), human("mate", "mateaaaa")],
        nations: ["raider"],
        boss: "bossaaaa",
        config: { difficulty },
      });
      const boss = game.player("boss");
      const mate = game.player("mate");
      const raider = game.player("raider");
      giveBands(game, [mate, raider, boss]);
      expect(bossFor(game, raider)).toBe(boss);
      expect(bossFor(game, boss)).toBeNull();
      raider.setTroops(game.config().maxTroops(raider));
      boss.setTroops(1_000);

      const random = new PseudoRandom(7);
      const emoji = new NationEmojiBehavior(random, game, raider);
      const behavior = new NationAttackBehavior(
        random,
        game,
        raider,
        0.5,
        0.3,
        0.1,
        new NationAllianceBehavior(random, game, raider, emoji),
        emoji,
        new NationWarshipBehavior(random, game, raider, emoji),
      );
      const strategies: Array<() => boolean> = (
        behavior as any
      ).getAttackStrategies([mate], [boss]);
      (behavior as any).landNeighbors = new Set([mate, boss]);
      expect(strategies[BOSS_STRATEGY_SLOT[difficulty]]()).toBe(true);
      executeTicks(game, 1);
      const targets = raider.outgoingAttacks().map((a) => a.target());
      expect(targets).toContain(boss);
      expect(targets).not.toContain(mate);
    },
  );
});

describe("Boss Raid alliances", () => {
  test("the Boss line: one side the Boss, the other a Raider", () => {
    const config = { gameMode: GameMode.Team, bossRaid: { boss: "nation" } };
    const on = (team: string | null) => ({ team: () => team });
    const boss = on(BOSS_RAID_BOSS_TEAM);
    const raider = on(BOSS_RAID_RAIDER_TEAM);
    expect(acrossBossLine(config, boss, raider)).toBe(true);
    expect(acrossBossLine(config, raider, boss)).toBe(true);
    expect(acrossBossLine(config, raider, raider)).toBe(false);
    expect(acrossBossLine(config, boss, on("Bot"))).toBe(false);
    expect(
      acrossBossLine({ ...config, bossRaid: undefined }, boss, raider),
    ).toBe(false);
  });

  async function allianceGame(boss: string) {
    const game = await bossRaidGame({
      humans: [human("human", "humanaaa")],
      nations: ["nation"],
      boss,
      // Easy nations accept most early requests, and some at random.
      config: { difficulty: Difficulty.Easy },
    });
    giveBands(game, [game.player("human"), game.player("nation")]);
    const nation = game.player("nation");
    const random = new PseudoRandom(3);
    const emoji = new NationEmojiBehavior(random, game, nation);
    const decide = (other: Player): boolean[] =>
      Array.from({ length: 40 }, () =>
        (
          new NationAllianceBehavior(random, game, nation, emoji) as any
        ).getAllianceDecision(other, true),
      );
    return { game, human: game.player("human"), nation, decide };
  }

  test("a nation Raider never allies a human Boss", async () => {
    const { human: boss, nation, decide } = await allianceGame("humanaaa");
    expect(nation.team()).toBe(BOSS_RAID_RAIDER_TEAM);
    expect(decide(boss).some((yes) => yes)).toBe(false);
  });

  test("a nation Boss never allies a human Raider", async () => {
    const { human: raider, nation, decide } = await allianceGame("nation");
    expect(nation.team()).toBe(BOSS_RAID_BOSS_TEAM);
    expect(decide(raider).some((yes) => yes)).toBe(false);
  });

  test("nobody allies the Boss, humans included", async () => {
    const game = await bossRaidGame({
      humans: [human("boss", "bossaaaa"), human("raider", "raider01")],
      nations: [],
      boss: "bossaaaa",
    });
    const boss = game.player("boss");
    const raider = game.player("raider");
    giveBands(game, [boss, raider]);
    expect(raider.canSendAllianceRequest(boss)).toBe(false);
    expect(boss.canSendAllianceRequest(raider)).toBe(false);
    game.addExecution(new AllianceRequestExecution(raider, boss.id()));
    game.addExecution(new AllianceRequestExecution(boss, raider.id()));
    executeTicks(game, 2);
    expect(boss.incomingAllianceRequests()).toHaveLength(0);
    expect(raider.incomingAllianceRequests()).toHaveLength(0);
    expect(raider.isAlliedWith(boss)).toBe(false);
  });
});

describe("Boss Raid start shield", () => {
  test("a quarter of the troops per attack for the first 3 minutes", () => {
    expect(BOSS_RAID_SHIELD_TICKS).toBe(1800);
    expect(bossShieldAttackCap(0, 100_000)).toBe(25_000);
    expect(bossShieldAttackCap(1799, 100_000)).toBe(25_000);
    expect(bossShieldAttackCap(1800, 100_000)).toBe(Infinity);
  });

  async function shieldGame() {
    const game = await bossRaidGame({
      humans: [human("boss", "bossaaaa"), human("raider", "raider01")],
      nations: [],
      boss: "bossaaaa",
    });
    const boss = game.player("boss");
    const raider = game.player("raider");
    giveBands(game, [boss, raider]);
    boss.setTroops(400_000);
    raider.setTroops(400_000);
    return { game, boss, raider };
  }

  test("the Boss's attack holds 25% of its troops, the rest stays home", async () => {
    const { game, boss, raider } = await shieldGame();
    game.addExecution(new AttackExecution(300_000, boss, raider.id()));
    executeTicks(game, 1);
    const sent = boss.outgoingAttacks().reduce((sum, a) => sum + a.troops(), 0);
    expect(sent).toBeLessThanOrEqual(100_000);
    expect(sent).toBeGreaterThan(90_000);
    // A second click adds to the same attack, still within the cap.
    game.addExecution(new AttackExecution(200_000, boss, raider.id()));
    executeTicks(game, 1);
    const total =
      boss.troops() +
      boss.outgoingAttacks().reduce((sum, a) => sum + a.troops(), 0);
    const after = boss
      .outgoingAttacks()
      .reduce((sum, a) => sum + a.troops(), 0);
    expect(after).toBeLessThanOrEqual(Math.floor(total / 4) + 1);
  });

  test("a Raider is not shielded", async () => {
    const { game, boss, raider } = await shieldGame();
    game.addExecution(new AttackExecution(300_000, raider, boss.id()));
    executeTicks(game, 1);
    const raid = raider
      .outgoingAttacks()
      .reduce((sum, a) => sum + a.troops(), 0);
    expect(raid).toBeGreaterThan(250_000);
  });

  test("after 3 minutes the Boss attacks with what it likes", async () => {
    const { game, boss, raider } = await shieldGame();
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(BOSS_RAID_SHIELD_TICKS);
    game.addExecution(new AttackExecution(300_000, boss, raider.id()));
    executeTicks(game, 1);
    const sent = boss.outgoingAttacks().reduce((sum, a) => sum + a.troops(), 0);
    expect(sent).toBeGreaterThan(250_000);
  });
});

describe("Boss Raid snapshots", () => {
  test("teams, N and the timer survive a round trip", async () => {
    const game = await bossRaidGame({
      humans: [human("me", "meeeeeee", true)],
      nations: ["n1", "n2", "n3"],
      boss: BOSS_RAID_NATION_BOSS,
    });
    const boss = bossOf(game);
    giveBands(game, game.allPlayers());
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 3);
    const restored = await expectSnapshotRoundTrip(game, MAP, 10);
    expect(restored.config().bossRaidRaiderWeight()).toBe(150 + 2 * 35);
    expect(restored.config().gameConfig().maxTimerValue).toBe(
      BOSS_RAID_DEFAULT_TIMER_MINUTES,
    );
    expect(restored.player(boss.id()).team()).toBe(BOSS_RAID_BOSS_TEAM);
    expect(restored.config().difficultyFor(restored.player(boss.id()))).toBe(
      Difficulty.Impossible,
    );
  });
});
