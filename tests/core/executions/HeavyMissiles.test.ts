import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  BALLISTIC_MISSILE_BLAST_RADIUS,
  BALLISTIC_MISSILE_TROOP_KILL_PERCENT,
  CLUSTER_WARHEAD_COUNT,
} from "@openfront/engine-lib/game/ConventionalWar";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  order,
  runUntil,
  structure,
} from "../../util/ConventionalWar";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 plains. a holds x < 40, b holds x >= 100.
async function sides(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
    infiniteGold: true,
  });
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 40, 200);
  conquerRect(game, b, 100, 0, 200, 200);
  return { game, a, b };
}

function airborne(game: Game, type: UnitType): number {
  return game.units(type).length;
}

describe("ballistic missile", () => {
  test("destroys every structure within 20 tiles, no land change", async () => {
    const { game, a, b } = await sides();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 2);
    const target = game.ref(150, 100);
    const r = BALLISTIC_MISSILE_BLAST_RADIUS;
    const inside = [
      structure(game, b, UnitType.City, game.ref(150 + r - 1, 100)),
      structure(game, b, UnitType.Port, game.ref(150, 100 - r + 1)),
      structure(game, b, UnitType.Factory, game.ref(150 - 10, 100 + 10)),
      structure(game, b, UnitType.DefensePost, game.ref(150, 100)),
    ];
    const outside = structure(
      game,
      b,
      UnitType.City,
      game.ref(150 + r + 2, 100),
    );
    const owned = b.numTilesOwned();
    b.setTroops(1_000_000);
    order(game, a, UnitType.BallisticMissile, target);
    executeTicks(game, 3);
    expect(airborne(game, UnitType.BallisticMissile)).toBe(1);
    runUntil(game, () => airborne(game, UnitType.BallisticMissile) === 0, 100);
    for (const s of inside) expect(s.isActive(), s.type()).toBe(false);
    expect(outside.isActive()).toBe(true);
    expect(b.numTilesOwned()).toBe(owned);
    expect(game.owner(target).id()).toBe(b.id());
    expect(game.hasFallout(target)).toBe(false);
    // 10% of 1M, and nothing more.
    expect(b.troops()).toBe(
      1_000_000 - (1_000_000 * BALLISTIC_MISSILE_TROOP_KILL_PERCENT) / 100,
    );
  });

  test("10% of an attack whose front lies in the blast", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 100, 200);
    conquerRect(game, b, 100, 0, 200, 200);
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 2);
    b.setTroops(500_000);
    game.addExecution(new AttackExecution(200_000, b, a.id(), null));
    executeTicks(game, 2);
    const attack = b.outgoingAttacks()[0];
    order(game, a, UnitType.BallisticMissile, game.ref(105, 100));
    executeTicks(game, 3);
    const missile = game.units(UnitType.BallisticMissile)[0];
    let before = 0;
    for (let i = 0; i < 100 && missile.isActive(); i++) {
      before = attack.troops();
      executeTicks(game, 1);
    }
    // The blast took 10% of what the attack held (it also fought a).
    expect(attack.troops()).toBeLessThan(before * 0.95);
  });

  test("friendly fire: the launcher's and its allies' structures and troops in the blast are hit too", async () => {
    const { game, players } = await conventionalGame(
      "big_plains",
      ["a", "b", "c"],
      { infiniteGold: true },
    );
    const [a, b, c] = players;
    conquerRect(game, a, 0, 0, 40, 200);
    conquerRect(game, b, 100, 0, 200, 200);
    // a's exclave and its ally c's land, both inside the blast.
    conquerRect(game, a, 140, 95, 145, 100);
    conquerRect(game, c, 155, 100, 160, 105);
    a.createAllianceRequest(c)!.accept();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 2);
    const own = structure(game, a, UnitType.DefensePost, game.ref(142, 97));
    const allied = structure(game, c, UnitType.City, game.ref(157, 102));
    const enemy = structure(game, b, UnitType.City, game.ref(150, 110));
    a.setTroops(500_000);
    c.setTroops(100_000);
    order(game, a, UnitType.BallisticMissile, game.ref(150, 100));
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.BallisticMissile) === 0, 100);
    expect(own.isActive()).toBe(false);
    expect(allied.isActive()).toBe(false);
    expect(enemy.isActive()).toBe(false);
    // 10% of everyone's troops with land in the blast, ours included.
    const kept = 1 - BALLISTIC_MISSILE_TROOP_KILL_PERCENT / 100;
    expect(a.troops()).toBe(500_000 * kept);
    expect(c.troops()).toBe(100_000 * kept);
  });

  test("a SAM intercepts it with one missile", async () => {
    const { game, a, b } = await sides();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 2);
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 100));
    order(game, a, UnitType.BallisticMissile, sam.tile());
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.BallisticMissile) === 0, 100);
    expect(sam.isActive()).toBe(true);
    expect(sam.isInCooldown()).toBe(true);
  });
});

describe("cluster missile", () => {
  test("splits into 8 warheads aimed at different structures, military first", async () => {
    const { game, a, b } = await sides();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 3);
    const target = game.ref(160, 100);
    const military = [
      structure(game, b, UnitType.DefensePost, game.ref(160, 100)),
      structure(game, b, UnitType.FlakGun, game.ref(160, 120)),
      structure(game, b, UnitType.Airbase, game.ref(180, 100)),
      structure(game, b, UnitType.MissileSilo, game.ref(140, 100)),
    ];
    const economic = [
      structure(game, b, UnitType.City, game.ref(160, 80)),
      structure(game, b, UnitType.City, game.ref(175, 120)),
      structure(game, b, UnitType.Port, game.ref(145, 80)),
      structure(game, b, UnitType.Factory, game.ref(145, 120)),
    ];
    const far = structure(game, b, UnitType.City, game.ref(195, 160));
    order(game, a, UnitType.ClusterMissile, target);
    executeTicks(game, 3);
    expect(airborne(game, UnitType.ClusterMissile)).toBe(1);
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) > 0, 100);
    expect(airborne(game, UnitType.ClusterMissile)).toBe(0);
    executeTicks(game, 1);
    expect(airborne(game, UnitType.ClusterWarhead)).toBe(CLUSTER_WARHEAD_COUNT);
    const owned = b.numTilesOwned();
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) === 0, 100);
    for (const s of [...military, ...economic]) {
      expect(s.isActive(), s.type()).toBe(false);
    }
    expect(far.isActive()).toBe(true);
    expect(b.numTilesOwned()).toBe(owned);
  });

  test("friendly fire: a warhead destroys our and our allies' military structures within 3 tiles", async () => {
    const { game, players } = await conventionalGame(
      "big_plains",
      ["a", "b", "c"],
      { infiniteGold: true },
    );
    const [a, b, c] = players;
    conquerRect(game, a, 0, 0, 40, 200);
    conquerRect(game, b, 100, 0, 200, 200);
    conquerRect(game, a, 161, 101, 165, 104);
    conquerRect(game, c, 157, 97, 160, 100);
    a.createAllianceRequest(c)!.accept();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 3);
    // The only hostile structure, so all 8 warheads land on it.
    const post = structure(game, b, UnitType.DefensePost, game.ref(160, 100));
    const own = structure(game, a, UnitType.FlakGun, game.ref(161, 101));
    const allied = structure(game, c, UnitType.DefensePost, game.ref(158, 98));
    // Economic structures in a warhead's blast are spared, ours too.
    const ownCity = structure(game, a, UnitType.City, game.ref(162, 102));
    // Military, but 5 tiles away: spared.
    const farOwn = structure(game, a, UnitType.FlakGun, game.ref(164, 103));
    order(game, a, UnitType.ClusterMissile, post.tile());
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) > 0, 100);
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) === 0, 100);
    expect(post.isActive()).toBe(false);
    expect(own.isActive()).toBe(false);
    expect(allied.isActive()).toBe(false);
    expect(ownCity.isActive()).toBe(true);
    expect(farOwn.isActive()).toBe(true);
  });

  test("airstrikes and cruise missiles spare our own and allied structures", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 40, 200);
    conquerRect(game, b, 100, 0, 200, 200);
    conquerRect(game, a, 150, 100, 152, 102);
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 3);
    structure(game, a, UnitType.Airbase, game.ref(30, 100));
    const enemy = structure(game, b, UnitType.DefensePost, game.ref(150, 98));
    const own = structure(game, a, UnitType.FlakGun, game.ref(150, 100));
    order(game, a, UnitType.CruiseMissile, enemy.tile());
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.CruiseMissile) === 0, 100);
    expect(enemy.isActive()).toBe(false);
    expect(own.isActive()).toBe(true);
    const enemy2 = structure(game, b, UnitType.DefensePost, game.ref(150, 99));
    order(game, a, UnitType.Airstrike, game.ref(150, 99));
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.Airstrike) === 0, 100);
    expect(enemy2.isActive()).toBe(false);
    expect(own.isActive()).toBe(true);
  });

  test("each warhead can be intercepted; the carrier can't", async () => {
    const { game, a, b } = await sides();
    structure(game, a, UnitType.MissileSilo, game.ref(10, 100), 3);
    // A level-3 SAM covering the target: three tubes, so three warheads die.
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 140), 3);
    executeTicks(game, 60);
    const posts = [80, 95, 110, 125].map((y) =>
      structure(game, b, UnitType.DefensePost, game.ref(160, y)),
    );
    order(game, a, UnitType.ClusterMissile, game.ref(160, 100));
    executeTicks(game, 3);
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) > 0, 100);
    runUntil(game, () => airborne(game, UnitType.ClusterWarhead) === 0, 100);
    // The SAM spent its missiles on warheads; the rest got through.
    expect(sam.missileTimerQueue().length).toBeGreaterThan(0);
    const survivors = posts.filter((p) => p.isActive()).length;
    expect(survivors).toBeLessThan(posts.length);
  });
});
