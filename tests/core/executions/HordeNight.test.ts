import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_BAND_MIN_SPACING,
  HORDE_DEFENDERS_TEAM,
  HORDE_FIRST_WAVE_DELAY_TICKS,
  HORDE_TEAM,
  HORDE_WAVE_INTERVAL_TICKS,
  hordeBandCount,
  hordeBandTroops,
  hordeNightOutcome,
  hordeTicksUntilNextWave,
  hordeWaveLandingTick,
  hordeWavePool,
  hordeWavesLanded,
  isHordeBand,
} from "@openfront/engine-lib/game/HordeNight";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { HordeBandExecution } from "@openfront/engine/execution/HordeBandExecution";
import { HordeNightExecution } from "@openfront/engine/execution/HordeNightExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  fightSurvivalThreat,
  hordeTarget,
} from "@openfront/engine/execution/nation/NationSurvivalBehavior";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// plains: 100x100, all land, so bands land on the map edge.
const PLAINS = "plains";

function human(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Human, `c_${id}`, id);
}
function nation(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Nation, null, id);
}

async function hordeGame(
  players: PlayerInfo[],
  config: Record<string, unknown> = {},
): Promise<Game> {
  return setup(
    PLAINS,
    {
      hordeNight: { enabled: true, survivalMinutes: 30 },
      ...config,
    },
    players,
  );
}

/** A band of `troops` on the rect, the way HordeNightExecution lands one. */
function band(
  game: Game,
  id: string,
  rect: [number, number, number, number],
  troops = 10_000,
): Player {
  const p = game.addPlayer(
    new PlayerInfo(id, PlayerType.Bot, null, id),
    HORDE_TEAM,
  );
  conquerRect(game, p, ...rect);
  p.setSpawnTile(game.ref(rect[0], rect[1]));
  p.setTroops(troops);
  return p;
}

function bands(game: Game): Player[] {
  return game.allPlayers().filter(isHordeBand);
}

function nationBehavior(game: Game, player: Player): NationAttackBehavior {
  return new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    player,
    0,
    0,
    0,
    { maybeSendAllianceRequests: vi.fn(), maybeBetray: vi.fn() } as any,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as any,
    { clearSeaLane: vi.fn() } as any,
  );
}

describe("Horde Night schedule and strength", () => {
  test("first wave 2 minutes after the spawn phase, then every 3 minutes", () => {
    expect(HORDE_FIRST_WAVE_DELAY_TICKS).toBe(1200);
    expect(HORDE_WAVE_INTERVAL_TICKS).toBe(1800);
    expect(hordeWaveLandingTick(1)).toBe(1200);
    expect(hordeWaveLandingTick(2)).toBe(3000);
    expect(hordeWaveLandingTick(10)).toBe(17_400);
    expect(hordeWavesLanded(0)).toBe(0);
    expect(hordeWavesLanded(1199)).toBe(0);
    expect(hordeWavesLanded(1200)).toBe(1);
    expect(hordeWavesLanded(2999)).toBe(1);
    expect(hordeWavesLanded(3000)).toBe(2);
    expect(hordeTicksUntilNextWave(0)).toBe(1200);
    expect(hordeTicksUntilNextWave(1200)).toBe(1800);
    expect(hordeTicksUntilNextWave(2999)).toBe(1);
  });

  test("pool is 40,000 × wave × (1 + 0.5 × defenders), split over 2 + wave bands", () => {
    expect(hordeWavePool(1, 0)).toBe(40_000);
    expect(hordeWavePool(1, 1)).toBe(60_000);
    expect(hordeWavePool(3, 4)).toBe(40_000 * 3 * 3);
    expect(hordeWavePool(5, 3)).toBe(500_000);
    expect(hordeBandCount(1)).toBe(3);
    expect(hordeBandCount(7)).toBe(9);
    expect(hordeBandTroops(1, 2)).toBe(Math.floor(80_000 / 3));
    expect(hordeBandTroops(5, 3)).toBe(Math.floor(500_000 / 7));
  });

  test("outcome: horde once every spawned human is gone, defenders at the timer", () => {
    const base = { spawnedHumans: 2, survivalMinutes: 30 };
    expect(
      hordeNightOutcome({ ...base, aliveHumans: 1, ticksSinceStart: 17_999 }),
    ).toBeNull();
    expect(
      hordeNightOutcome({ ...base, aliveHumans: 1, ticksSinceStart: 18_000 }),
    ).toBe("defenders");
    expect(
      hordeNightOutcome({ ...base, aliveHumans: 0, ticksSinceStart: 100 }),
    ).toBe("horde");
    expect(
      hordeNightOutcome({
        spawnedHumans: 0,
        aliveHumans: 0,
        survivalMinutes: 30,
        ticksSinceStart: 50_000,
      }),
    ).toBeNull();
  });
});

describe("Horde Night sides", () => {
  test("off by default: no teams in FFA", async () => {
    const game = await setup(PLAINS, {}, [human("a"), nation("n")]);
    expect(game.config().hordeNightConfig()).toEqual({
      enabled: false,
      survivalMinutes: 30,
    });
    expect(game.player("a").team()).toBeNull();
    expect(game.player("a").isFriendly(game.player("n"))).toBe(false);
  });

  test("every human and nation is one allied side, in FFA and team lobbies", async () => {
    for (const config of [{}, { gameMode: GameMode.Team, playerTeams: 2 }]) {
      const game = await hordeGame(
        [human("a"), human("b"), nation("n")],
        config,
      );
      const [a, b, n] = ["a", "b", "n"].map((id) => game.player(id));
      for (const p of [a, b, n]) expect(p.team()).toBe(HORDE_DEFENDERS_TEAM);
      expect(a.isFriendly(b)).toBe(true);
      expect(a.isFriendly(n)).toBe(true);
      expect(n.isFriendly(b)).toBe(true);
    }
  });

  test("defenders can't attack each other; bands are hostile and stick together", async () => {
    const game = await hordeGame([human("a"), nation("n")]);
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, a, 20, 20, 40, 40);
    conquerRect(game, n, 40, 20, 60, 40);
    a.setTroops(50_000);
    const nTiles = n.numTilesOwned();
    game.addExecution(new AttackExecution(10_000, a, n.id()));
    executeTicks(game, 5);
    expect(n.numTilesOwned()).toBe(nTiles);

    const b1 = band(game, "band1", [0, 0, 5, 5]);
    const b2 = band(game, "band2", [95, 95, 100, 100]);
    expect(b1.isFriendly(b2)).toBe(true);
    expect(b1.isFriendly(a)).toBe(false);
    expect(a.isFriendly(b1)).toBe(false);
  });
});

describe("Horde Night waves", () => {
  test("wave 1 lands at 2 minutes: 2 + 1 bands on the map edge, sharing the pool", async () => {
    const game = await hordeGame([human("a"), nation("n")]);
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, a, 30, 30, 45, 45);
    conquerRect(game, n, 55, 55, 70, 70);
    a.setSpawnTile(game.ref(37, 37));
    n.setSpawnTile(game.ref(62, 62));
    const exec = new HordeNightExecution("horde-test");
    game.addExecution(exec);

    let ticks = 0;
    while (bands(game).length === 0 && ticks < 1300) {
      executeTicks(game, 1);
      ticks++;
    }
    // Landed in the tick that ran at 1200 ticks since the spawn phase.
    expect(Math.round(game.elapsedGameSeconds() * 10)).toBe(1201);
    expect(exec.waves()).toBe(1);
    const landed = bands(game);
    expect(landed.length).toBe(hordeBandCount(1));
    for (const b of landed) {
      expect(b.type()).toBe(PlayerType.Bot);
      expect(b.troops()).toBe(hordeBandTroops(1, 2));
      expect(game.isOnEdgeOfMap(b.spawnTile()!)).toBe(true);
    }
    for (let i = 0; i < landed.length; i++) {
      for (let j = i + 1; j < landed.length; j++) {
        expect(
          game.euclideanDistSquared(
            landed[i].spawnTile()!,
            landed[j].spawnTile()!,
          ),
        ).toBeGreaterThanOrEqual(HORDE_BAND_MIN_SPACING ** 2);
      }
    }

    // The bands go for the defenders at once.
    executeTicks(game, 20);
    for (const b of landed) {
      expect(b.outgoingAttacks().length).toBeGreaterThan(0);
    }
  });

  test("the next wave lands 3 minutes later, stronger", async () => {
    const game = await hordeGame([human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 30, 30, 70, 70);
    const exec = new HordeNightExecution("horde-test");
    game.addExecution(exec);
    executeTicks(game, 3000);
    expect(exec.waves()).toBe(1);
    executeTicks(game, 2);
    expect(exec.waves()).toBe(2);
    expect(bands(game).length).toBe(hordeBandCount(1) + hordeBandCount(2));
  });

  test("a band goes for the nearest non-horde player and never allies", async () => {
    const game = await hordeGame([human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 10, 40, 20, 60);
    conquerRect(game, b, 80, 40, 90, 60);
    const horde = band(game, "band1", [0, 45, 3, 55]);
    const exec = new HordeBandExecution(horde);
    exec.init(game);
    expect(exec.nearestPlayer()?.player).toBe(a);

    const request = a.createAllianceRequest(horde);
    expect(request).not.toBeNull();
    game.addExecution(exec);
    executeTicks(game, 12);
    expect(request!.status()).toBe("rejected");
    expect(a.isAlliedWith(horde)).toBe(false);
    // Not bordering a yet: it marches through free land toward it.
    expect(horde.outgoingAttacks().length).toBeGreaterThan(0);
  });
});

describe("Horde Night win check", () => {
  test("the defenders win when a human survives the timer", async () => {
    const game = await hordeGame([human("a"), nation("n")], {
      hordeNight: { enabled: true, survivalMinutes: 1 },
    });
    const a = game.player("a");
    conquerRect(game, a, 30, 30, 40, 40);
    a.setSpawnTile(game.ref(35, 35));
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 590);
    expect(game.getWinner()).toBeNull();
    executeTicks(game, 20);
    expect(game.getWinner()).toBe(HORDE_DEFENDERS_TEAM);
  });

  test("the horde wins once every defending human is gone, nations or not", async () => {
    const game = await hordeGame([human("a"), human("b"), nation("n")]);
    const [a, b, n] = ["a", "b", "n"].map((id) => game.player(id));
    for (const [p, x] of [
      [a, 10],
      [b, 40],
      [n, 70],
    ] as const) {
      conquerRect(game, p, x, 10, x + 10, 20);
      p.setSpawnTile(game.ref(x + 5, 15));
    }
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 20);
    for (const t of Array.from(a.tiles())) a.relinquish(t);
    executeTicks(game, 20);
    expect(game.getWinner()).toBeNull();
    for (const t of Array.from(b.tiles())) b.relinquish(t);
    executeTicks(game, 20);
    expect(n.isAlive()).toBe(true);
    expect(game.getWinner()).toBe(HORDE_TEAM);
  });
});

describe("Horde Night nation AI", () => {
  test("a nation fights a bordering band first and leaves fellow defenders alone", async () => {
    const game = await hordeGame([human("a"), nation("n")], {
      difficulty: Difficulty.Medium,
    });
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, n, 0, 0, 100, 50);
    conquerRect(game, a, 0, 50, 50, 100);
    const horde = band(game, "band1", [50, 50, 100, 100], 5_000);
    n.setTroops(200_000);
    nationBehavior(game, n).maybeAttack();
    executeTicks(game, 1);
    const targets = n.outgoingAttacks().map((t) => t.target());
    expect(targets).toContain(horde);
    expect(targets).not.toContain(a);
  });

  test("the band attacking hardest goes first, and an Easy nation only sometimes", async () => {
    const game = await hordeGame([nation("n")], {
      difficulty: Difficulty.Hard,
    });
    const n = game.player("n");
    conquerRect(game, n, 30, 0, 70, 100);
    const weak = band(game, "weak", [0, 0, 30, 100], 1_000);
    const strong = band(game, "strong", [70, 0, 100, 100], 90_000);
    expect(hordeTarget(n)).toBe(weak);
    game.addExecution(new AttackExecution(50_000, strong, n.id()));
    executeTicks(game, 1);
    expect(hordeTarget(n)).toBe(strong);

    n.setTroops(100_000);
    expect(fightSurvivalThreat(game, n, new PseudoRandom(1), 0.3, 0.1)).toBe(
      true,
    );
    executeTicks(game, 1);
    expect(n.outgoingAttacks().map((t) => t.target())).toContain(strong);
  });

  test("does nothing with Horde Night and the plague off", async () => {
    const game = await setup(PLAINS, {}, [nation("n")]);
    const n = game.player("n");
    conquerRect(game, n, 0, 0, 50, 50);
    const random = new PseudoRandom(7);
    const before = random.getState();
    expect(fightSurvivalThreat(game, n, random, 0.3, 0.1)).toBe(false);
    expect(random.getState()).toEqual(before);
  });
});

describe("Horde Night snapshots", () => {
  test("a landed wave round-trips mid-attack", async () => {
    const game = await hordeGame([human("a"), nation("n")]);
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, a, 30, 30, 45, 45);
    conquerRect(game, n, 55, 55, 70, 70);
    a.setSpawnTile(game.ref(37, 37));
    game.addExecution(new HordeNightExecution("horde-test"));
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 1215);
    expect(bands(game).length).toBe(3);
    await expectSnapshotRoundTrip(game, PLAINS, 40);
  }, 60_000);
});
