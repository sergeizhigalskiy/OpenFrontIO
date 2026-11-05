import {
  Difficulty,
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  contactInfectionBps,
  contactInfectionLoss,
  INFECTED_NAME,
  INFECTED_PLAYER_ID,
  INFECTED_TEAM,
  isInfected,
  outbreakTiles,
  pickOutbreakCenter,
  PLAGUE_MIN_SPAWN_DISTANCE,
  PLAGUE_START_TROOPS,
  plagueCaptureTroops,
  plagueConsumedWorld,
  plagueDecay,
} from "@openfront/engine-lib/game/Plague";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  fightSurvivalThreat,
  sharedBorderTiles,
  smallestPocketTile,
} from "@openfront/engine/execution/nation/NationSurvivalBehavior";
import {
  decayInfected,
  infectByContact,
  infectedBorderCounts,
  PlagueExecution,
  spreadInfected,
} from "@openfront/engine/execution/PlagueExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { conquerRect } from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// plains: 100x100 and big_plains: 200x200, both all land.
const PLAINS = "plains";
const BIG = "big_plains";

function human(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Human, `c_${id}`, id);
}
function nation(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Nation, null, id);
}

async function plagueGame(
  map: string,
  players: PlayerInfo[],
  config: Record<string, unknown> = {},
): Promise<Game> {
  return setup(map, { plague: true, ...config }, players);
}

/** The Infected placed by hand (PlagueExecution breaks it out on its own). */
function infectedOn(game: Game, rect: [number, number, number, number]) {
  const infected = game.addPlayer(
    new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
  );
  conquerRect(game, infected, ...rect);
  infected.setSpawnTile(game.ref(rect[0], rect[1]));
  return infected;
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

describe("plague rules", () => {
  test("off by default", async () => {
    const game = await setup(PLAINS, {}, [human("a")]);
    expect(game.config().plague()).toBe(false);
  });

  test("capture raises half the defender's troops-per-tile", () => {
    expect(plagueCaptureTroops(10_000, 100)).toBe(50);
    expect(plagueCaptureTroops(999, 10)).toBe(49);
    expect(plagueCaptureTroops(5_000, 0)).toBe(0);
  });

  test("contact infection: 0.5% per 100 shared tiles, capped at 3%", () => {
    expect(contactInfectionBps(0)).toBe(0);
    expect(contactInfectionBps(100)).toBe(50);
    expect(contactInfectionBps(250)).toBe(125);
    expect(contactInfectionBps(599)).toBe(299);
    expect(contactInfectionBps(600)).toBe(300);
    expect(contactInfectionBps(5_000)).toBe(300);
    expect(contactInfectionLoss(100_000, 100)).toBe(500);
    expect(contactInfectionLoss(100_000, 10_000)).toBe(3_000);
  });

  test("decay is 0.2% and the world is lost at 70%", () => {
    expect(plagueDecay(100_000)).toBe(200);
    expect(plagueDecay(499)).toBe(0);
    expect(plagueConsumedWorld(6_999, 10_000)).toBe(false);
    expect(plagueConsumedWorld(7_000, 10_000)).toBe(true);
  });
});

describe("plague outbreak", () => {
  test("placement is deterministic and at least 60 tiles from every spawn", async () => {
    const game = await setup(BIG, {});
    const spawns = [
      game.ref(40, 40),
      game.ref(160, 40),
      game.ref(100, 100),
      game.ref(40, 160),
    ];
    const first = pickOutbreakCenter(game.map(), new PseudoRandom(9), spawns);
    const again = pickOutbreakCenter(game.map(), new PseudoRandom(9), spawns);
    expect(first).not.toBeNull();
    expect(again).toBe(first);
    for (const s of spawns) {
      expect(game.euclideanDistSquared(first!, s)).toBeGreaterThanOrEqual(
        PLAGUE_MIN_SPAWN_DISTANCE ** 2,
      );
    }
    // A disc of radius 10: 317 tiles of open land.
    expect(outbreakTiles(game.map(), game.ref(100, 100)).length).toBe(317);
  });

  test("breaks out 2 minutes after the spawn phase with 30,000 troops", async () => {
    const game = await plagueGame(BIG, [human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 20, 20, 30, 30);
    conquerRect(game, b, 170, 170, 180, 180);
    a.setSpawnTile(game.ref(25, 25));
    b.setSpawnTile(game.ref(175, 175));
    const exec = new PlagueExecution("plague-test");
    game.addExecution(exec);
    let ticks = 0;
    while (exec.infectedPlayer() === null && ticks < 1300) {
      executeTicks(game, 1);
      ticks++;
    }
    expect(Math.round(game.elapsedGameSeconds() * 10)).toBe(1201);
    const infected = exec.infectedPlayer()!;
    expect(infected.id()).toBe(INFECTED_PLAYER_ID);
    expect(infected.type()).toBe(PlayerType.Bot);
    // Its whole pool went straight out in attacks.
    const inAttacks = infected
      .outgoingAttacks()
      .reduce((sum, attack) => sum + attack.troops(), 0);
    expect(infected.outgoingAttacks().length).toBeGreaterThan(0);
    expect(infected.troops() + inAttacks).toBe(PLAGUE_START_TROOPS);
    const center = infected.spawnTile()!;
    for (const s of [a.spawnTile()!, b.spawnTile()!]) {
      expect(game.euclideanDistSquared(center, s)).toBeGreaterThanOrEqual(
        PLAGUE_MIN_SPAWN_DISTANCE ** 2,
      );
    }
    expect(infected.numTilesOwned()).toBe(
      outbreakTiles(game.map(), center).length,
    );
    // Another game with the same seed and spawns breaks out on the same tile.
    const twin = await plagueGame(BIG, [human("a"), human("b")]);
    twin.player("a").setSpawnTile(game.ref(25, 25));
    twin.player("b").setSpawnTile(game.ref(175, 175));
    conquerRect(twin, twin.player("a"), 20, 20, 30, 30);
    conquerRect(twin, twin.player("b"), 170, 170, 180, 180);
    const twinExec = new PlagueExecution("plague-test");
    twin.addExecution(twinExec);
    executeTicks(twin, 1201);
    expect(twinExec.infectedPlayer()!.spawnTile()).toBe(center);
  });
});

describe("plague infection", () => {
  test("each tile taken in battle adds half the defender's troops-per-tile", async () => {
    // TestConfig: one tile a tick, the defender loses 1 troop per tile.
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 50, 100);
    a.setTroops(100_000);
    const infected = infectedOn(game, [50, 0, 100, 100]);
    infected.setTroops(20_000);
    game.addExecution(new AttackExecution(10_000, infected, a.id()));
    executeTicks(game, 1);
    for (let i = 0; i < 5; i++) {
      const troops = a.troops();
      const tiles = a.numTilesOwned();
      const reserve = infected.troops();
      executeTicks(game, 1);
      expect(a.numTilesOwned()).toBe(tiles - 1);
      expect(infected.troops() - reserve).toBe(
        plagueCaptureTroops(troops, tiles),
      );
    }
  });

  test("no zombies for anyone else's attacks", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 50, 100);
    a.setTroops(100_000);
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe_id"),
    );
    conquerRect(game, tribe, 50, 0, 100, 100);
    tribe.setTroops(20_000);
    game.addExecution(new AttackExecution(10_000, tribe, a.id()));
    executeTicks(game, 1);
    const reserve = tribe.troops();
    executeTicks(game, 5);
    expect(tribe.troops()).toBe(reserve);
  });

  test("contact infection bleeds the shared border's rate into The Infected", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 50, 100);
    a.setTroops(100_000);
    const infected = infectedOn(game, [50, 0, 52, 100]);
    infected.setTroops(1_000);
    const shown = vi.spyOn(game, "displayMessage");

    const border = infectedBorderCounts(game, infected);
    expect(border.get(a.smallID())).toBe(100);
    expect(sharedBorderTiles(game, a, infected)).toBe(100);
    const bleeding = infectByContact(game, infected, border, []);
    expect(bleeding).toEqual([a.smallID()]);
    expect(a.troops()).toBe(100_000 - 500);
    expect(infected.troops()).toBe(1_000 + 500);
    expect(shown).toHaveBeenCalledWith(
      "events_display.plague_contact_infection",
      expect.anything(),
      a.id(),
      undefined,
      { percent: 0.5 },
    );
    // Told once, when it starts.
    shown.mockClear();
    infectByContact(game, infected, border, bleeding);
    expect(shown).not.toHaveBeenCalled();
  });

  test("contact infection is capped at 3% however long the border", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    const infected = game.addPlayer(
      new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
    );
    // Interleaved columns: every tile of a's touches infected land.
    for (let x = 0; x < 100; x++) {
      conquerRect(game, x % 2 === 0 ? infected : a, x, 0, x + 1, 100);
    }
    a.setTroops(100_000);
    infected.setTroops(0);
    const border = infectedBorderCounts(game, infected);
    expect(border.get(a.smallID())).toBe(5_000);
    infectByContact(game, infected, border, []);
    expect(a.troops()).toBe(97_000);
    expect(infected.troops()).toBe(3_000);
  });

  test("The Infected never regrows; its pool decays 0.2% per interval", async () => {
    const game = await plagueGame(PLAINS, []);
    const infected = infectedOn(game, [40, 40, 60, 60]);
    infected.setTroops(50_000);
    expect(game.config().troopIncreaseRate(infected)).toBe(0);
    game.addExecution(new PlayerExecution(infected));
    executeTicks(game, 50);
    expect(infected.troops()).toBe(50_000);

    // Same id with the plague off grows like any tribe.
    const off = await setup(PLAINS, {});
    const bot = off.addPlayer(
      new PlayerInfo(INFECTED_NAME, PlayerType.Bot, null, INFECTED_PLAYER_ID),
    );
    conquerRect(off, bot, 40, 40, 60, 60);
    expect(off.config().troopIncreaseRate(bot)).toBeGreaterThan(0);

    // The troops at home and those attacking both decay.
    infected.setTroops(100_000);
    game.addExecution(new AttackExecution(40_000, infected, null));
    executeTicks(game, 1);
    const attack = infected.outgoingAttacks()[0];
    const home = infected.troops();
    const away = attack.troops();
    decayInfected(infected);
    expect(infected.troops()).toBe(home - plagueDecay(home));
    expect(attack.troops()).toBe(away - plagueDecay(away));
  });

  test("it spreads its whole pool across all its borders", async () => {
    const game = await plagueGame(PLAINS, [human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 0, 0, 40, 100);
    conquerRect(game, b, 60, 0, 100, 50);
    const infected = infectedOn(game, [40, 0, 60, 100]);
    infected.setTroops(30_000);
    spreadInfected(game, infected, infectedBorderCounts(game, infected));
    executeTicks(game, 1);
    const targets = infected.outgoingAttacks().map((t) => t.target());
    expect(targets).toContain(a);
    expect(targets).toContain(b);
    expect(targets).toContain(game.terraNullius());
    expect(infected.troops()).toBe(0);
  });
});

describe("plague pocket annexation", () => {
  test("a pocket walled in by one player is annexed, and so is a ringed main body", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 100, 100);
    const infected = infectedOn(game, [90, 0, 100, 100]);
    conquerRect(game, infected, 40, 40, 45, 45);
    expect(a.isFriendly(infected)).toBe(false);
    expect(infected.isFriendly(a)).toBe(false);
    game.addExecution(new PlayerExecution(infected));
    executeTicks(game, 25);
    // A tile change makes the engine look at the Infected's clusters again.
    infected.conquer(game.ref(89, 50));
    executeTicks(game, 45);
    expect(game.owner(game.ref(42, 42))).toBe(a);
    expect(infected.numTilesOwned()).toBeGreaterThan(900);

    // Ringed with no way out: the whole body goes.
    const ringed = await plagueGame(PLAINS, [human("a")]);
    const ra = ringed.player("a");
    conquerRect(ringed, ra, 0, 0, 100, 100);
    const body = infectedOn(ringed, [30, 30, 60, 60]);
    ringed.addExecution(new PlayerExecution(body));
    executeTicks(ringed, 25);
    body.conquer(ringed.ref(60, 45));
    executeTicks(ringed, 45);
    expect(body.isAlive()).toBe(false);
  });
});

describe("plague win check", () => {
  async function standings(config: Record<string, unknown> = {}) {
    const game = await plagueGame(
      PLAINS,
      [human("a"), human("b"), nation("n")],
      config,
    );
    const [a, b, n] = ["a", "b", "n"].map((id) => game.player(id));
    conquerRect(game, a, 0, 0, 30, 100);
    conquerRect(game, b, 30, 0, 40, 100);
    conquerRect(game, n, 40, 0, 60, 100);
    const infected = infectedOn(game, [60, 0, 70, 100]);
    const winCheck = new WinCheckExecution();
    winCheck.init(game, 0);
    return { game, a, b, n, infected, winCheck };
  }

  test("while The Infected lives nobody wins on the plague's rules", async () => {
    const { game, winCheck } = await standings();
    winCheck.tick(10);
    expect(game.getWinner()).toBeNull();
  });

  test("once it is eliminated, the living player with the most land wins", async () => {
    const { game, a, infected, winCheck } = await standings();
    for (const t of Array.from(infected.tiles())) infected.relinquish(t);
    winCheck.tick(10);
    expect(game.getWinner()).toBe(a);
  });

  test("in team games that player's team wins", async () => {
    const { game, a, infected, winCheck } = await standings({
      gameMode: GameMode.Team,
      playerTeams: 2,
    });
    for (const t of Array.from(infected.tiles())) infected.relinquish(t);
    winCheck.tick(10);
    expect(game.getWinner()).toBe(a.team());
  });

  test("everyone loses once The Infected holds 70% of the land", async () => {
    const { game, infected, winCheck } = await standings();
    conquerRect(game, infected, 0, 0, 60, 99);
    conquerRect(game, infected, 1, 99, 60, 100);
    expect(infected.numTilesOwned()).toBe(6_999);
    winCheck.tick(10);
    expect(game.getWinner()).toBeNull();
    infected.conquer(game.ref(0, 99));
    expect(infected.numTilesOwned()).toBe(7_000);
    winCheck.tick(20);
    expect(game.getWinner()).toBe(INFECTED_TEAM);
  });

  test("The Infected never wins on land or time", async () => {
    const { game, a, infected, winCheck } = await standings({
      maxTimerValue: 1,
    });
    // The Infected holds the most land (40%) when the lobby timer runs out.
    conquerRect(game, infected, 30, 0, 60, 100);
    expect(isInfected(infected)).toBe(true);
    expect(infected.numTilesOwned()).toBeGreaterThan(a.numTilesOwned());
    executeTicks(game, 600);
    winCheck.tick(610);
    expect(game.getWinner()).toBe(a);
  });
});

describe("plague nation AI", () => {
  test("a nation bordering The Infected attacks it first", async () => {
    const game = await plagueGame(PLAINS, [nation("n"), nation("m")], {
      difficulty: Difficulty.Medium,
    });
    const [n, m] = [game.player("n"), game.player("m")];
    conquerRect(game, n, 0, 0, 40, 100);
    conquerRect(game, m, 40, 0, 60, 50);
    infectedOn(game, [40, 50, 60, 100]);
    n.setTroops(200_000);
    m.setTroops(1_000);
    nationBehavior(game, n).maybeAttack();
    executeTicks(game, 1);
    const targets = n.outgoingAttacks().map((t) => t.target());
    expect(targets.map((t) => t.isPlayer() && t.id())).toEqual([
      INFECTED_PLAYER_ID,
    ]);
  });

  test("heavily infected-bordered, it attacks nobody else; lightly, it may", async () => {
    // Impossible counts 100 shared tiles as heavy, Medium needs 300.
    for (const [difficulty, heavy] of [
      [Difficulty.Impossible, true],
      [Difficulty.Medium, false],
    ] as const) {
      const game = await plagueGame(PLAINS, [nation("n"), nation("m")], {
        difficulty,
      });
      const [n, m] = [game.player("n"), game.player("m")];
      conquerRect(game, n, 1, 0, 40, 100);
      conquerRect(game, m, 40, 0, 60, 100);
      // The infected front: a column of 100 of n's tiles.
      const infected = infectedOn(game, [0, 0, 1, 100]);
      expect(sharedBorderTiles(game, n, infected)).toBe(100);
      // Nothing to spare above the reserve: no attack on The Infected.
      n.setTroops(1);
      expect(fightSurvivalThreat(game, n, new PseudoRandom(3), 0.5, 0.5)).toBe(
        heavy,
      );
      executeTicks(game, 1);
      expect(n.outgoingAttacks().length).toBe(0);
    }
  });

  test("Hard and Impossible spearhead into the smallest infected pocket", async () => {
    const game = await plagueGame(PLAINS, [nation("n")], {
      difficulty: Difficulty.Hard,
    });
    const n = game.player("n");
    conquerRect(game, n, 0, 0, 90, 100);
    const infected = infectedOn(game, [90, 0, 100, 100]);
    conquerRect(game, infected, 40, 40, 43, 43);
    const pocket = smallestPocketTile(game, n, infected)!;
    expect(pocket).not.toBeNull();
    expect(game.x(pocket)).toBeGreaterThanOrEqual(40);
    expect(game.x(pocket)).toBeLessThan(43);
    n.setTroops(300_000);
    expect(fightSurvivalThreat(game, n, new PseudoRandom(3), 0.3, 0.1)).toBe(
      true,
    );
    executeTicks(game, 1);
    expect(n.outgoingAttacks()[0].target()).toBe(infected);
  });
});

describe("plague snapshots", () => {
  test("an outbreak mid-spread round-trips", async () => {
    const game = await plagueGame(BIG, [human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 0, 0, 80, 200);
    conquerRect(game, b, 120, 0, 200, 200);
    a.setSpawnTile(game.ref(20, 100));
    b.setSpawnTile(game.ref(180, 100));
    a.setTroops(100_000);
    b.setTroops(100_000);
    game.addExecution(new PlagueExecution("plague-test"));
    game.addExecution(new WinCheckExecution());
    executeTicks(game, 1230);
    expect(game.hasPlayer(INFECTED_PLAYER_ID)).toBe(true);
    await expectSnapshotRoundTrip(game, BIG, 60);
  }, 60_000);
});
