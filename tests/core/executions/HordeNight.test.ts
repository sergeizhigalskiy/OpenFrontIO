import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_BAND_CLEANUP_TICKS,
  HORDE_BAND_MIN_SPACING,
  HORDE_DEFENDERS_TEAM,
  HORDE_FIRST_WAVE_DELAY_TICKS,
  HORDE_HUMAN_WAVE_PERCENT,
  HORDE_NATION_WAVE_PERCENT,
  HORDE_NIGHT_DEFAULT_SURVIVAL_MINUTES,
  HORDE_NIGHT_SURVIVAL_CHOICES,
  HORDE_TEAM,
  HORDE_WAVE_INTERVAL_TICKS,
  hordeBandCount,
  hordeBandSpent,
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
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerRect } from "../../util/GameHelpers";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// plains: 100x100, all land, so bands land on the map edge.
const PLAINS = "plains";
// half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15.
const COAST = "half_land_half_ocean";

function human(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Human, `c_${id}`, id);
}
function nation(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Nation, null, id);
}

async function hordeGame(
  players: PlayerInfo[],
  config: Record<string, unknown> = {},
  map = PLAINS,
): Promise<Game> {
  return setup(
    map,
    {
      hordeNight: { enabled: true, survivalMinutes: 25 },
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

function bandExecs(game: Game): HordeBandExecution[] {
  return game
    .executions()
    .filter((e): e is HordeBandExecution => e instanceof HordeBandExecution);
}

/** Runs until `ticksSinceStart` ticks have passed since the spawn phase. */
function runTo(game: Game, ticksSinceStart: number): void {
  while (game.ticksSinceStart() < ticksSinceStart) executeTicks(game, 1);
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

  test("25 minutes by default, 8 waves; the lobby offers 15, 20, 25, 30 and 45", () => {
    expect(HORDE_NIGHT_DEFAULT_SURVIVAL_MINUTES).toBe(25);
    expect(hordeWavesLanded(25 * 600 - 1)).toBe(8);
    expect(HORDE_NIGHT_SURVIVAL_CHOICES).toEqual([15, 20, 25, 30, 45]);
  });

  test("a human's wave is 0.35x their max troops, +25% a wave, over 2 + wave/2 bands", () => {
    expect(HORDE_HUMAN_WAVE_PERCENT).toBe(35);
    expect(HORDE_NATION_WAVE_PERCENT).toBe(15);
    const max = 1_000_000;
    expect(hordeWavePool(max, 1, HORDE_HUMAN_WAVE_PERCENT)).toBe(350_000);
    expect(hordeWavePool(max, 5, HORDE_HUMAN_WAVE_PERCENT)).toBe(700_000);
    expect(hordeWavePool(max, 10, HORDE_HUMAN_WAVE_PERCENT)).toBe(1_137_500);
    expect(hordeWavePool(max, 1, HORDE_NATION_WAVE_PERCENT)).toBe(150_000);
    expect(hordeBandCount(1)).toBe(2);
    expect(hordeBandCount(2)).toBe(3);
    expect(hordeBandCount(5)).toBe(4);
    expect(hordeBandCount(10)).toBe(7);
  });

  test("outcome: horde once every human is dead or overrun, a narrow win between 25% and 50%", () => {
    const at = (
      humans: { alive: boolean; tiles: number; startTiles: number | null }[],
      ticksSinceStart: number,
    ) => hordeNightOutcome({ humans, ticksSinceStart, survivalMinutes: 25 });
    const end = 25 * 600;
    const h = (tiles: number, alive = true) => ({
      alive,
      tiles,
      startTiles: 100,
    });
    expect(at([h(100)], end - 1)).toBeNull();
    expect(at([h(50)], end)).toBe("defenders");
    expect(at([h(49)], end)).toBe("narrow");
    expect(at([h(25)], end)).toBe("narrow");
    // Under 25% is overrun at once, timer or not.
    expect(at([h(24)], 100)).toBe("horde");
    expect(at([h(24), h(80)], 100)).toBeNull();
    expect(at([h(24), h(80)], end)).toBe("defenders");
    expect(at([h(24), h(30)], end)).toBe("narrow");
    expect(at([h(0, false)], 100)).toBe("horde");
    // Before the land is recorded only death counts.
    expect(at([{ alive: true, tiles: 1, startTiles: null }], 100)).toBeNull();
    expect(at([], end)).toBeNull();
  });

  test("a band bleeds out under 10% of its landing troops", () => {
    expect(HORDE_BAND_CLEANUP_TICKS).toBe(900);
    expect(hordeBandSpent(9_999, 100_000)).toBe(true);
    expect(hordeBandSpent(10_000, 100_000)).toBe(false);
  });
});

describe("Horde Night sides", () => {
  test("off by default: no teams in FFA", async () => {
    const game = await setup(PLAINS, {}, [human("a"), nation("n")]);
    expect(game.config().hordeNightConfig()).toEqual({
      enabled: false,
      survivalMinutes: 25,
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
  test("wave 1 lands at 2 minutes: a wave per defender, sized by its max troops, never on held land", async () => {
    const game = await hordeGame([human("a"), nation("n")]);
    const [a, n] = [game.player("a"), game.player("n")];
    // a reaches the west edge, so a band could land on its tiles if allowed.
    conquerRect(game, a, 0, 30, 15, 45);
    conquerRect(game, n, 55, 55, 70, 70);
    a.setSpawnTile(game.ref(7, 37));
    n.setSpawnTile(game.ref(62, 62));
    const aTiles = new Set(a.tiles());
    const nTiles = new Set(n.tiles());
    const aPool = hordeWavePool(
      game.config().maxTroops(a),
      1,
      HORDE_HUMAN_WAVE_PERCENT,
    );
    const nPool = hordeWavePool(
      game.config().maxTroops(n),
      1,
      HORDE_NATION_WAVE_PERCENT,
    );
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
    expect(landed.length).toBe(2 * hordeBandCount(1));
    const execs = bandExecs(game);
    expect(execs).toHaveLength(landed.length);
    const forA = execs.filter((e) => e.assignedDefender() === a);
    const forN = execs.filter((e) => e.assignedDefender() === n);
    expect(forA).toHaveLength(2);
    expect(forN).toHaveLength(2);
    for (const e of forA) expect(e.strength()).toBe(Math.floor(aPool / 2));
    for (const e of forN) expect(e.strength()).toBe(Math.floor(nPool / 2));
    for (const b of landed) {
      expect(b.type()).toBe(PlayerType.Bot);
      expect(game.isOnEdgeOfMap(b.spawnTile()!)).toBe(true);
      for (const t of b.tiles()) {
        expect(aTiles.has(t)).toBe(false);
        expect(nTiles.has(t)).toBe(false);
      }
    }
    expect(a.numTilesOwned()).toBe(aTiles.size);
    const aSites = forA.map((e) => (e as any).band.spawnTile());
    expect(game.euclideanDistSquared(aSites[0], aSites[1])).toBeGreaterThan(
      HORDE_BAND_MIN_SPACING ** 2 - 1,
    );

    // The bands go for their defenders at once.
    executeTicks(game, 20);
    for (const b of landed) {
      expect(b.outgoingAttacks().length).toBeGreaterThan(0);
    }
  });

  test("the next wave lands 3 minutes later, stronger", async () => {
    const game = await hordeGame([human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 30, 30, 70, 70);
    a.setSpawnTile(game.ref(50, 50));
    const exec = new HordeNightExecution("horde-test");
    game.addExecution(exec);
    executeTicks(game, 3000);
    expect(exec.waves()).toBe(1);
    executeTicks(game, 2);
    expect(exec.waves()).toBe(2);
    expect(bands(game).length).toBe(hordeBandCount(1) + hordeBandCount(2));
  });

  test("bands keep the troops they land with: no growth, no cap", async () => {
    const game = await hordeGame([human("a")]);
    const big = band(game, "big", [0, 0, 7, 7], 3_000_000);
    expect(game.config().maxTroops(big)).toBeLessThan(3_000_000);
    expect(game.config().troopIncreaseRate(big)).toBe(0);
    game.addExecution(new PlayerExecution(big));
    executeTicks(game, 20);
    expect(big.troops()).toBe(3_000_000);
  });

  test("a band goes for its defender; once it falls, the nearest one", async () => {
    const game = await hordeGame([human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 10, 40, 20, 60);
    conquerRect(game, b, 80, 40, 90, 60);
    const horde = band(game, "band1", [0, 45, 3, 55]);
    // Sent at b, though a is nearer.
    const exec = new HordeBandExecution(horde, b, 10_000);
    exec.init(game, game.ticks());
    expect(exec.nearestPlayer()?.player).toBe(a);

    const request = a.createAllianceRequest(horde);
    expect(request).not.toBeNull();
    game.addExecution(exec);
    executeTicks(game, 12);
    expect(request!.status()).toBe("rejected");
    expect(a.isAlliedWith(horde)).toBe(false);
    // Not bordering b yet: it marches through free land toward it.
    expect(horde.outgoingAttacks().length).toBeGreaterThan(0);
    expect((exec as any).target).toBe(b);

    for (const t of Array.from(b.tiles())) b.relinquish(t);
    executeTicks(game, 12);
    expect((exec as any).target).toBe(a);
  });

  test("a spent band disbands after 90 s and frees its land", async () => {
    const game = await hordeGame([human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 40, 40, 60, 60);
    const weak = band(game, "weak", [0, 0, 5, 5], 9_000);
    const fresh = band(game, "fresh", [94, 94, 100, 100], 10_000);
    // Both landed with 100k: one has 9% of it left, the other 10%. Their
    // attacks are stopped, so neither spends a troop.
    const init = vi
      .spyOn(AttackExecution.prototype, "init")
      .mockImplementation(function (this: any) {
        this.active = false;
      });
    game.addExecution(
      new HordeBandExecution(weak, a, 100_000),
      new HordeBandExecution(fresh, a, 100_000),
    );
    executeTicks(game, HORDE_BAND_CLEANUP_TICKS - 20);
    expect(weak.isAlive()).toBe(true);
    executeTicks(game, 40);
    expect(weak.isAlive()).toBe(false);
    expect(weak.troops()).toBe(0);
    expect(game.owner(game.ref(2, 2)).isPlayer()).toBe(false);
    expect(fresh.isAlive()).toBe(true);
    init.mockRestore();
  });

  test("with no free coast near, the bands sail in from the map edge", async () => {
    const game = await hordeGame([human("a")], {}, COAST);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 8, 16);
    a.setSpawnTile(game.ref(3, 8));
    a.setTroops(1_000);
    const all = a.numTilesOwned();
    game.addExecution(new HordeNightExecution("horde-test"));
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 1);
    const inbound = bands(game);
    expect(inbound).toHaveLength(hordeBandCount(1));
    for (const b of inbound) {
      // No land of its own: it is on a boat.
      expect(b.numTilesOwned()).toBe(0);
      expect(b.units(UnitType.TransportShip)).toHaveLength(1);
    }
    expect(a.numTilesOwned()).toBe(all);
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 200);
    expect(inbound.some((b) => b.isAlive())).toBe(true);
    const execs = bandExecs(game);
    expect(execs.length).toBeGreaterThan(0);
    for (const e of execs) expect(e.assignedDefender()).toBe(a);
    expect(a.numTilesOwned()).toBeLessThan(all);
  });
});

describe("Horde Night win check", () => {
  async function winGame(minutes = 25) {
    const game = await hordeGame([human("a"), nation("n")], {
      hordeNight: { enabled: true, survivalMinutes: minutes },
    });
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, a, 30, 30, 50, 50);
    conquerRect(game, n, 60, 60, 70, 70);
    a.setSpawnTile(game.ref(40, 40));
    n.setSpawnTile(game.ref(65, 65));
    // No waves: only the clock and the recorded land matter here.
    const exec = new HordeNightExecution("horde-test");
    vi.spyOn(exec as any, "landWave").mockImplementation(() => {});
    game.addExecution(exec, new WinCheckExecution());
    return { game, a, n, exec };
  }

  function shrinkTo(p: Player, tiles: number): void {
    for (const t of Array.from(p.tiles()).slice(tiles)) p.relinquish(t);
  }

  test("each human's land is recorded when the first wave lands", async () => {
    const { game, a, n, exec } = await winGame();
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS - 1);
    expect(exec.startTiles(a)).toBeNull();
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 1);
    expect(exec.startTiles(a)).toBe(400);
    expect(exec.startTiles(n)).toBeNull();
  });

  test("a human under 25% of that land is overrun: the horde wins", async () => {
    const { game, a } = await winGame();
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 20);
    shrinkTo(a, 100);
    executeTicks(game, 20);
    expect(game.getWinner()).toBeNull();
    shrinkTo(a, 99);
    executeTicks(game, 20);
    expect(a.isAlive()).toBe(true);
    expect(game.getWinner()).toBe(HORDE_TEAM);
  });

  test("at the timer: a full win holding half, a narrow one under it", async () => {
    for (const [tiles, outcome] of [
      [200, "defenders"],
      [199, "narrow"],
    ] as const) {
      const { game, a, exec } = await winGame(5);
      runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 20);
      shrinkTo(a, tiles);
      runTo(game, 5 * 600 - 20);
      expect(game.getWinner()).toBeNull();
      runTo(game, 5 * 600 + 20);
      expect(game.getWinner()).toBe(HORDE_DEFENDERS_TEAM);
      expect((exec as any).outcome).toBe(outcome);
    }
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
    expect(bands(game).length).toBe(2 * hordeBandCount(1));
    await expectSnapshotRoundTrip(game, PLAINS, 40);
  }, 60_000);

  test("a snapshot taken just before a wave lands it the same way", async () => {
    const game = await hordeGame([human("a"), nation("n")]);
    const [a, n] = [game.player("a"), game.player("n")];
    conquerRect(game, a, 0, 30, 15, 45);
    conquerRect(game, n, 55, 55, 70, 70);
    a.setSpawnTile(game.ref(7, 37));
    n.setSpawnTile(game.ref(62, 62));
    game.addExecution(new HordeNightExecution("horde-test"));
    game.addExecution(new WinCheckExecution());
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS - 5);
    expect(bands(game)).toHaveLength(0);
    await expectSnapshotRoundTrip(game, PLAINS, 30);
    expect(bands(game).length).toBeGreaterThan(0);
  }, 60_000);

  test("bands on their boats round-trip", async () => {
    const game = await hordeGame([human("a")], {}, COAST);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 8, 16);
    a.setSpawnTile(game.ref(3, 8));
    game.addExecution(new HordeNightExecution("horde-test"));
    game.addExecution(new WinCheckExecution());
    runTo(game, HORDE_FIRST_WAVE_DELAY_TICKS + 2);
    expect(bands(game).every((b) => b.numTilesOwned() === 0)).toBe(true);
    await expectSnapshotRoundTrip(game, COAST, 60);
  }, 60_000);
});
