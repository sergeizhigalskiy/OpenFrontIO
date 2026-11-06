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
  PLAGUE_COMEBACK_DELAY_TICKS,
  PLAGUE_CURE_GROWTH_TICKS,
  PLAGUE_MAX_OUTBREAKS,
  PLAGUE_MIN_SPAWN_DISTANCE,
  PLAGUE_OUTBREAK_DELAY_TICKS,
  PLAGUE_OUTBREAK_RADIUS,
  plagueCaptureTroops,
  plagueComebackTroops,
  plagueComesBack,
  plagueConsumedWorld,
  plagueCureGold,
  plagueDecay,
  plagueSiteCount,
  plagueSpreadTroops,
  plagueStartTroops,
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
import { conquerRect } from "../../util/GameHelpers";
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

  test("outbreaks: at 4:00, 0.75x the strongest player's troops but at least 30k", () => {
    expect(PLAGUE_OUTBREAK_DELAY_TICKS).toBe(2400);
    expect(plagueStartTroops(100_000)).toBe(75_000);
    expect(plagueStartTroops(10_000)).toBe(30_000);
    expect(plagueSiteCount(5)).toBe(1);
    expect(plagueSiteCount(6)).toBe(2);
  });

  test("comebacks: wiped before 20:00, 1.5x the last start 3 minutes later, 3 outbreaks at most", () => {
    expect(PLAGUE_COMEBACK_DELAY_TICKS).toBe(1800);
    expect(PLAGUE_MAX_OUTBREAKS).toBe(3);
    expect(plagueComebackTroops(100_000)).toBe(150_000);
    expect(plagueComesBack(1, 11_999)).toBe(true);
    expect(plagueComesBack(1, 12_000)).toBe(false);
    expect(plagueComesBack(2, 5_000)).toBe(true);
    expect(plagueComesBack(3, 5_000)).toBe(false);
  });

  test("the cure pays 500k per outbreak number at the gold multiplier, and spread keeps half", () => {
    expect(plagueCureGold(1, 1)).toBe(500_000n);
    expect(plagueCureGold(3, 1)).toBe(1_500_000n);
    expect(plagueCureGold(2, 0.5)).toBe(500_000n);
    expect(PLAGUE_CURE_GROWTH_TICKS).toBe(1200);
    expect(plagueSpreadTroops(30_001)).toBe(15_000);
  });
});

describe("plague outbreak", () => {
  test("placement is deterministic, on free land, at least 60 tiles from every spawn", async () => {
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
    expect(again).toEqual(first);
    expect(first!.farEnough).toBe(true);
    for (const s of spawns) {
      expect(game.euclideanDistSquared(first!.tile, s)).toBeGreaterThanOrEqual(
        PLAGUE_MIN_SPAWN_DISTANCE ** 2,
      );
    }
    // A disc of radius 10: 317 tiles of open land.
    expect(outbreakTiles(game.map(), game.ref(100, 100)).length).toBe(317);
  });

  test("the disc covers only free land; with none 60 tiles away, the farthest free tile", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    // Everything held but a strip on the east edge, 85 to 95 tiles from a's
    // spawn; a spawn in the middle of the strip as well.
    conquerRect(game, a, 0, 0, 90, 100);
    const spawns = [game.ref(5, 50), game.ref(95, 50)];
    const pick = pickOutbreakCenter(game.map(), new PseudoRandom(4), spawns)!;
    expect(pick.farEnough).toBe(false);
    expect(game.x(pick.tile)).toBeGreaterThanOrEqual(90);
    expect(game.owner(pick.tile).isPlayer()).toBe(false);
    // Farthest from both spawns: a corner of the strip.
    expect([0, 99]).toContain(game.y(pick.tile));
    const disc = outbreakTiles(game.map(), pick.tile);
    expect(disc.length).toBeGreaterThan(0);
    for (const t of disc) expect(game.owner(t).isPlayer()).toBe(false);
    // Nothing free at all: no centre.
    conquerRect(game, a, 90, 0, 100, 100);
    expect(pickOutbreakCenter(game.map(), new PseudoRandom(4), spawns)).toBe(
      null,
    );
  });

  test("breaks out 4 minutes after the spawn phase with 0.75x the strongest player's troops", async () => {
    const game = await plagueGame(BIG, [human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 20, 20, 30, 30);
    conquerRect(game, b, 170, 170, 180, 180);
    a.setSpawnTile(game.ref(25, 25));
    b.setSpawnTile(game.ref(175, 175));
    a.setTroops(100_000);
    b.setTroops(50_000);
    const exec = new PlagueExecution("plague-test");
    game.addExecution(exec);
    runTo(game, PLAGUE_OUTBREAK_DELAY_TICKS - 1);
    expect(exec.infectedPlayer()).toBeNull();
    let ticks = 0;
    while (exec.infectedPlayer() === null && ticks < 100) {
      executeTicks(game, 1);
      ticks++;
    }
    expect(Math.round(game.elapsedGameSeconds() * 10)).toBe(
      PLAGUE_OUTBREAK_DELAY_TICKS + 1,
    );
    const infected = exec.infectedPlayer()!;
    expect(infected.id()).toBe(INFECTED_PLAYER_ID);
    expect(infected.type()).toBe(PlayerType.Bot);
    expect(exec.outbreakCount()).toBe(1);
    // Half its pool went straight out in attacks; half stays home.
    const inAttacks = infected
      .outgoingAttacks()
      .reduce((sum, attack) => sum + attack.troops(), 0);
    expect(infected.outgoingAttacks().length).toBeGreaterThan(0);
    expect(infected.troops() + inAttacks).toBe(75_000);
    expect(infected.troops()).toBe(75_000 - plagueSpreadTroops(75_000));
    const center = infected.spawnTile()!;
    for (const s of [a.spawnTile()!, b.spawnTile()!]) {
      expect(game.euclideanDistSquared(center, s)).toBeGreaterThanOrEqual(
        PLAGUE_MIN_SPAWN_DISTANCE ** 2,
      );
    }
    // The disc of free land around the centre, and nothing else.
    let disc = 0;
    const r = PLAGUE_OUTBREAK_RADIUS;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = game.x(center) + dx;
        const y = game.y(center) + dy;
        if (!game.isValidCoord(x, y)) continue;
        expect(game.owner(game.ref(x, y))).toBe(infected);
        disc++;
      }
    }
    expect(infected.numTilesOwned()).toBe(disc);
    // Another game with the same seed and spawns breaks out on the same tile.
    const twin = await plagueGame(BIG, [human("a"), human("b")]);
    twin.player("a").setSpawnTile(game.ref(25, 25));
    twin.player("b").setSpawnTile(game.ref(175, 175));
    conquerRect(twin, twin.player("a"), 20, 20, 30, 30);
    conquerRect(twin, twin.player("b"), 170, 170, 180, 180);
    const twinExec = new PlagueExecution("plague-test");
    twin.addExecution(twinExec);
    executeTicks(twin, PLAGUE_OUTBREAK_DELAY_TICKS + 1);
    expect(twinExec.infectedPlayer()!.spawnTile()).toBe(center);
  });

  test("with 6 humans and nations, two sites share the troops", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const game = await plagueGame(BIG, ids.map(human));
    // Small holdings in a ring around the middle, far from the corners.
    ids.forEach((id, i) => {
      const p = game.player(id);
      const x = 30 + (i % 3) * 70;
      const y = i < 3 ? 30 : 170;
      conquerRect(game, p, x - 3, y - 3, x + 3, y + 3);
      p.setSpawnTile(game.ref(x, y));
      p.setTroops(100_000);
    });
    const exec = new PlagueExecution("plague-test");
    game.addExecution(exec);
    runTo(game, PLAGUE_OUTBREAK_DELAY_TICKS + 1);
    const infected = exec.infectedPlayer()!;
    const home = infected.troops();
    const away = infected
      .outgoingAttacks()
      .reduce((sum, attack) => sum + attack.troops(), 0);
    expect(home + away).toBe(75_000);
    // Two discs, far apart.
    const disc = outbreakTiles(game.map(), game.ref(100, 100)).length;
    expect(infected.numTilesOwned()).toBeGreaterThan(disc);
    let far = false;
    const tiles = Array.from(infected.tiles());
    for (const t of tiles) {
      if (
        game.euclideanDistSquared(t, infected.spawnTile()!) >
        (4 * PLAGUE_OUTBREAK_RADIUS) ** 2
      ) {
        far = true;
      }
    }
    expect(far).toBe(true);
  });
});

describe("plague cure and comebacks", () => {
  // a holds the west strip; the outbreak lands on the free land east of it.
  async function cureGame(config: Record<string, unknown> = {}) {
    const game = await plagueGame(PLAINS, [human("a")], config);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 10, 100);
    a.setSpawnTile(game.ref(5, 50));
    a.setTroops(100_000);
    const exec = new PlagueExecution("plague-test");
    // No growth for a, so the first outbreak starts with exactly 75k.
    game.addExecution(exec);
    runTo(game, PLAGUE_OUTBREAK_DELAY_TICKS + 1);
    const infected = exec.infectedPlayer()!;
    expect(infected.isAlive()).toBe(true);
    return { game, a, exec, infected };
  }

  // a takes The Infected's last tiles, as an attack that finishes it would.
  function finishOff(game: Game, a: Player, infected: Player): void {
    game.conquerPlayer(a, infected);
    for (const t of Array.from(infected.tiles())) infected.relinquish(t);
  }

  test("whoever takes the last tile is paid 500k and grows 25% faster for 2 minutes", async () => {
    const { game, a, exec, infected } = await cureGame();
    const gold = a.gold();
    finishOff(game, a, infected);
    executeTicks(game, 1);
    expect(infected.isAlive()).toBe(false);
    expect(a.gold() - gold).toBe(plagueCureGold(1, 1));
    // No winner: the game goes on.
    expect(game.getWinner()).toBeNull();

    const since = game.ticksSinceStart();
    a.setTroops(50_000);
    const rate = game.config().troopIncreaseRate(a, since);
    (exec as any).growCurer(since);
    expect(a.troops() - 50_000).toBe(Math.floor(rate * 0.25));
    expect((exec as any).cureBonusUntil).toBe(
      since - 1 + PLAGUE_CURE_GROWTH_TICKS,
    );
    runTo(game, since + PLAGUE_CURE_GROWTH_TICKS);
    expect((exec as any).cureBonusPlayer).toBeNull();
  });

  test("an attack that wipes it out pays the attacker", async () => {
    const { game, a, infected } = await cureGame();
    // a borders what is left of it: 50 tiles, under the 100 an attack kills.
    for (const t of Array.from(infected.tiles()).slice(50)) a.conquer(t);
    game.map().forEachTile((t) => {
      if (game.isLand(t) && !game.owner(t).isPlayer()) a.conquer(t);
    });
    const gold = a.gold();
    a.setTroops(500_000);
    game.addExecution(new AttackExecution(400_000, a, infected.id()));
    executeTicks(game, 3);
    expect(infected.isAlive()).toBe(false);
    expect(a.gold() - gold).toBeGreaterThanOrEqual(plagueCureGold(1, 1));
  });

  test("wiped out early, it comes back 3 minutes later, 1.5x stronger, up to 3 outbreaks", async () => {
    const { game, a, exec, infected } = await cureGame();
    const starts = [75_000];
    for (let n = 2; n <= PLAGUE_MAX_OUTBREAKS; n++) {
      finishOff(game, a, infected);
      executeTicks(game, 1);
      const wiped = game.ticksSinceStart() - 1;
      expect(exec.nextOutbreak()).toBe(wiped + PLAGUE_COMEBACK_DELAY_TICKS);
      runTo(game, wiped + PLAGUE_COMEBACK_DELAY_TICKS - 1);
      expect(infected.isAlive()).toBe(false);
      runTo(game, wiped + PLAGUE_COMEBACK_DELAY_TICKS + 1);
      expect(infected.isAlive()).toBe(true);
      expect(exec.outbreakCount()).toBe(n);
      starts.push(plagueComebackTroops(starts[starts.length - 1]));
      const away = infected
        .outgoingAttacks()
        .reduce((sum, attack) => sum + attack.troops(), 0);
      expect(infected.troops() + away).toBe(starts[n - 1]);
    }
    expect(starts).toEqual([75_000, 112_500, 168_750]);
    // The third is the last.
    const gold = a.gold();
    finishOff(game, a, infected);
    executeTicks(game, 1);
    expect(a.gold() - gold).toBe(plagueCureGold(3, 1));
    expect(exec.nextOutbreak()).toBeNull();
    runTo(game, game.ticksSinceStart() + PLAGUE_COMEBACK_DELAY_TICKS + 10);
    expect(infected.isAlive()).toBe(false);
  });

  test("wiped out after 20:00, it stays gone", async () => {
    const { game, a, exec, infected } = await cureGame();
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(20 * 600);
    finishOff(game, a, infected);
    executeTicks(game, 1);
    expect(exec.nextOutbreak()).toBeNull();
  });

  test("the bounty follows the gold multiplier", async () => {
    const { game, a, infected } = await cureGame({ goldMultiplier: 2 });
    const gold = a.gold();
    finishOff(game, a, infected);
    executeTicks(game, 1);
    expect(a.gold() - gold).toBe(plagueCureGold(1, 2));
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

  test("it spreads half its pool across all its borders and keeps the rest", async () => {
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
    expect(infected.troops()).toBe(15_000);
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

  test("wiping it out never ends the game, in FFA or teams", async () => {
    for (const config of [{}, { gameMode: GameMode.Team, playerTeams: 2 }]) {
      const { game, infected, winCheck } = await standings(config);
      for (const t of Array.from(infected.tiles())) infected.relinquish(t);
      winCheck.tick(10);
      expect(game.getWinner()).toBeNull();
    }
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

  test("with nothing to spare it holds nothing back for The Infected", async () => {
    // It used to attack nobody else once heavily infected-bordered.
    for (const difficulty of [Difficulty.Medium, Difficulty.Impossible]) {
      const game = await plagueGame(PLAINS, [nation("n"), nation("m")], {
        difficulty,
      });
      const [n, m] = [game.player("n"), game.player("m")];
      conquerRect(game, n, 1, 0, 40, 100);
      conquerRect(game, m, 40, 0, 60, 100);
      // The infected front: a column of 100 of n's tiles.
      const infected = infectedOn(game, [0, 0, 1, 100]);
      expect(sharedBorderTiles(game, n, infected)).toBe(100);
      // Nothing to spare above the reserve: no attack, and the turn goes on.
      n.setTroops(1);
      expect(fightSurvivalThreat(game, n, new PseudoRandom(3), 0.5, 0.5)).toBe(
        false,
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
    executeTicks(game, PLAGUE_OUTBREAK_DELAY_TICKS + 30);
    expect(game.hasPlayer(INFECTED_PLAYER_ID)).toBe(true);
    await expectSnapshotRoundTrip(game, BIG, 60);
  }, 60_000);

  test("a snapshot taken just before the outbreak breaks it out the same way", async () => {
    const game = await plagueGame(BIG, [human("a"), human("b")]);
    const [a, b] = [game.player("a"), game.player("b")];
    conquerRect(game, a, 0, 0, 60, 200);
    conquerRect(game, b, 140, 0, 200, 200);
    a.setSpawnTile(game.ref(20, 100));
    b.setSpawnTile(game.ref(180, 100));
    a.setTroops(100_000);
    game.addExecution(new PlagueExecution("plague-test"));
    game.addExecution(new WinCheckExecution());
    runTo(game, PLAGUE_OUTBREAK_DELAY_TICKS - 5);
    expect(game.hasPlayer(INFECTED_PLAYER_ID)).toBe(false);
    await expectSnapshotRoundTrip(game, BIG, 20);
    expect(game.hasPlayer(INFECTED_PLAYER_ID)).toBe(true);
  }, 60_000);

  test("a cure and the wait for the comeback round-trip", async () => {
    const game = await plagueGame(PLAINS, [human("a")]);
    const a = game.player("a");
    conquerRect(game, a, 0, 0, 10, 100);
    a.setSpawnTile(game.ref(5, 50));
    a.setTroops(100_000);
    const exec = new PlagueExecution("plague-test");
    game.addExecution(exec, new PlayerExecution(a), new WinCheckExecution());
    runTo(game, PLAGUE_OUTBREAK_DELAY_TICKS + 5);
    const infected = exec.infectedPlayer()!;
    game.conquerPlayer(a, infected);
    for (const t of Array.from(infected.tiles())) infected.relinquish(t);
    executeTicks(game, 3);
    expect((exec as any).cureBonusPlayer).toBe(a);
    await expectSnapshotRoundTrip(game, PLAINS, 40);
  }, 60_000);
});
