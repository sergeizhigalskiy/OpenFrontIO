import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { BuildUnitIntentSchema } from "@openfront/engine-api/Schemas";
import { WARSHIP_MAX_HEALTH } from "@openfront/engine-lib/configuration/Config";
import {
  clampDroneSwarm,
  DRONE_BLAST_RADIUS,
  DRONE_COST,
  DRONE_LAUNCH_INTERVAL_TICKS,
  droneStructureDamage,
  droneWarshipDamage,
  WARSHIP_DRONE_HIT_PERCENT,
} from "@openfront/engine-lib/game/ConventionalWar";
import { ShellExecution } from "@openfront/engine/execution/ShellExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  order,
  runUntil,
  setGold,
  structure,
} from "../../util/ConventionalWar";
import { executeTicks } from "../../util/utils";

function drones(game: Game): Unit[] {
  return game.units(UnitType.Drone);
}

// big_plains: a holds x < 50, b holds x >= 50.
async function land(
  infiniteGold = true,
): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
    infiniteGold,
  });
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 50, 200);
  conquerRect(game, b, 50, 0, 200, 200);
  return { game, a, b };
}

// half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15. a holds
// x 0-3, b x 4-7.
async function sea(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame(
    "half_land_half_ocean",
    ["a", "b"],
    { infiniteGold: true },
  );
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 4, 16);
  conquerRect(game, b, 4, 0, 8, 16);
  return { game, a, b };
}

function warship(game: Game, owner: Player, tile: TileRef): Unit {
  return owner.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

/** Ticks until every swarm is out and every drone in the air is gone. */
function settle(game: Game, max = 400): void {
  runUntil(
    game,
    () =>
      drones(game).length === 0 &&
      !game
        .executions()
        .some((e) => e.constructor.name === "DroneSwarmExecution"),
    max,
  );
}

describe("drone swarms", () => {
  test("cost 40k each, one per airbase every 10 ticks", async () => {
    const { game, a, b } = await land(false);
    const gun = structure(game, b, UnitType.FlakGun, game.ref(120, 100));
    // Two airbases in range (100 tiles), one out of it.
    structure(game, a, UnitType.Airbase, game.ref(40, 90));
    structure(game, a, UnitType.Airbase, game.ref(40, 110));
    structure(game, a, UnitType.Airbase, game.ref(5, 190));
    setGold(a, 1_000_000n);
    expect(game.unitInfo(UnitType.Drone).cost(game, a)).toBe(
      BigInt(DRONE_COST),
    );
    const before = a.gold();
    order(game, a, UnitType.Drone, gun.tile(), { count: 5 });
    executeTicks(game, 3);
    expect(drones(game)).toHaveLength(2);
    expect(before - a.gold()).toBe(2n * BigInt(DRONE_COST));
    executeTicks(game, DRONE_LAUNCH_INTERVAL_TICKS - 1);
    expect(drones(game)).toHaveLength(2);
    executeTicks(game, 1);
    expect(drones(game)).toHaveLength(4);
    executeTicks(game, DRONE_LAUNCH_INTERVAL_TICKS);
    expect(drones(game)).toHaveLength(5);
    expect(before - a.gold()).toBe(5n * BigInt(DRONE_COST));
    // Drones don't use the airstrike sortie.
    for (const base of a.units(UnitType.Airbase)) {
      expect(base.isInCooldown()).toBe(false);
    }
  });

  test("swarm size is validated to 1-20 and charged per drone launched", async () => {
    const intent = (count: number) =>
      BuildUnitIntentSchema.safeParse({
        type: "build_unit",
        unit: UnitType.Drone,
        tile: 5,
        count,
      }).success;
    expect([0, 1, 20, 21].map(intent)).toEqual([false, true, true, false]);
    expect([0, 1, 5, 20, 99].map(clampDroneSwarm)).toEqual([1, 1, 5, 20, 20]);

    // 100k buys two drones: the queue stops when the gold runs out.
    const { game, a, b } = await land(false);
    const gun = structure(game, b, UnitType.FlakGun, game.ref(120, 100));
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    setGold(a, 100_000n);
    order(game, a, UnitType.Drone, gun.tile(), { count: 5 });
    executeTicks(game, 60);
    // Two launched and paid for, then the queue stopped.
    expect(a.gold()).toBe(100_000n - 2n * BigInt(DRONE_COST));
    expect(
      game
        .executions()
        .some((e) => e.constructor.name === "DroneSwarmExecution"),
    ).toBe(false);
  });

  test("every hostile structure but a SAM is a target, and ships", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(100, 100));
    expect(a.canBuild(UnitType.Drone, sam.tile())).toBe(false);
    // 10 tiles apart, so each click (8 tiles) can only pick its own.
    for (const [type, y] of [
      [UnitType.City, 60],
      [UnitType.Port, 70],
      [UnitType.Factory, 80],
      [UnitType.DefensePost, 90],
      [UnitType.MissileSilo, 110],
      [UnitType.Airbase, 120],
      [UnitType.FlakGun, 130],
      [UnitType.CoastalBattery, 140],
    ] as const) {
      const target = b.buildUnit(type, game.ref(110, y), {});
      expect(a.canBuild(UnitType.Drone, target.tile()), type).not.toBe(false);
    }
    // Never our own, and never too far from every airbase (100 tiles).
    const own = structure(game, a, UnitType.City, game.ref(20, 20));
    expect(a.canBuild(UnitType.Drone, own.tile())).toBe(false);
    const far = structure(game, b, UnitType.FlakGun, game.ref(190, 100));
    expect(a.canBuild(UnitType.Drone, far.tile())).toBe(false);
  });
});

describe("drones against structures", () => {
  test("a city survives 2 drone hits and dies to 3, whatever its level", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const city = structure(game, b, UnitType.City, game.ref(100, 100), 4);
    order(game, a, UnitType.Drone, city.tile(), { count: 2 });
    executeTicks(game, 3);
    settle(game);
    expect(city.isActive()).toBe(true);
    expect(city.droneHits()).toBe(2);
    // Hits never downgrade.
    expect(city.level()).toBe(4);
    order(game, a, UnitType.Drone, city.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(city.isActive()).toBe(false);
  });

  test("a siege camp survives 2 drone hits and dies to 3", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const camp = structure(game, b, UnitType.SiegeCamp, game.ref(100, 100));
    expect(a.canBuild(UnitType.Drone, camp.tile())).not.toBe(false);
    order(game, a, UnitType.Drone, camp.tile(), { count: 2 });
    executeTicks(game, 3);
    settle(game);
    expect(camp.isActive()).toBe(true);
    expect(camp.droneHits()).toBe(2);
    order(game, a, UnitType.Drone, camp.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(camp.isActive()).toBe(false);
  });

    test("a coastal battery loses a third of its health per hit", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const battery = b.buildUnit(
      UnitType.CoastalBattery,
      game.ref(100, 100),
      {},
    );
    const max = battery.maxHealth();
    order(game, a, UnitType.Drone, battery.tile(), { count: 2 });
    executeTicks(game, 3);
    settle(game);
    expect(battery.health()).toBe(max - 2 * droneStructureDamage(max));
    order(game, a, UnitType.Drone, battery.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(battery.isActive()).toBe(false);
  });

  test("the 1-tile blast hits every valid target next to the target, never a SAM", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const gun = b.buildUnit(UnitType.FlakGun, game.ref(100, 100), {});
    // One tile away: hit. Two tiles away: spared.
    const near = b.buildUnit(UnitType.FlakGun, game.ref(101, 100), {});
    const city = b.buildUnit(UnitType.City, game.ref(100, 101), {});
    const far = b.buildUnit(UnitType.FlakGun, game.ref(102, 100), {});
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(99, 100));
    // Our own structure in the blast is never hit.
    const own = a.buildUnit(UnitType.City, game.ref(100, 99), {});
    expect(DRONE_BLAST_RADIUS).toBe(1);
    order(game, a, UnitType.Drone, gun.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(gun.isActive()).toBe(false);
    expect(near.isActive()).toBe(false);
    expect(city.droneHits()).toBe(1);
    expect(far.isActive()).toBe(true);
    expect(sam.isActive()).toBe(true);
    expect(sam.droneHits()).toBe(0);
    expect(own.droneHits()).toBe(0);
  });

  test("the blast sinks ships next to the target too", async () => {
    const { game, a, b } = await sea();
    structure(game, a, UnitType.Airbase, game.ref(2, 8));
    const ship = warship(game, b, game.ref(13, 8));
    const boat = b.buildUnit(UnitType.TransportShip, game.ref(13, 9), {
      troops: 1_000,
    });
    order(game, a, UnitType.Drone, ship.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(boat.isActive()).toBe(false);
    expect(ship.health()).toBe(
      WARSHIP_MAX_HEALTH - droneWarshipDamage(WARSHIP_MAX_HEALTH),
    );
  });
});

describe("drones against flak guns", () => {
  test("a drone destroys an undefended flak gun", async () => {
    const { game, a, b } = await land();
    structure(game, a, UnitType.Airbase, game.ref(40, 100));
    const gun = b.buildUnit(UnitType.FlakGun, game.ref(100, 100), {});
    // No FlakGunExecution: the gun never fires.
    order(game, a, UnitType.Drone, gun.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(gun.isActive()).toBe(false);
  });

  test("a flak gun survives one drone more often than not, never a swarm of 8", async () => {
    let survived = 0;
    const trials = 40;
    for (let i = 0; i < trials; i++) {
      const { game, a, b } = await land();
      // Shifts the unit ids, and so the gun's seeded rolls, per trial.
      for (let k = 0; k < i; k++) {
        a.buildUnit(UnitType.City, game.ref(1 + (k % 40), 1 + (k % 7)), {});
      }
      structure(game, a, UnitType.Airbase, game.ref(30, 100));
      const gun = structure(game, b, UnitType.FlakGun, game.ref(120, 100));
      order(game, a, UnitType.Drone, gun.tile(), { count: 1 });
      executeTicks(game, 3);
      settle(game);
      if (gun.isActive()) survived++;
    }
    expect(survived).toBeGreaterThan(trials / 2);

    for (let i = 0; i < 5; i++) {
      const { game, a, b } = await land();
      for (let k = 0; k < i; k++) {
        a.buildUnit(UnitType.City, game.ref(1 + k, 1), {});
      }
      structure(game, a, UnitType.Airbase, game.ref(30, 100));
      const gun = structure(game, b, UnitType.FlakGun, game.ref(120, 100));
      order(game, a, UnitType.Drone, gun.tile(), { count: 8 });
      executeTicks(game, 3);
      settle(game);
      expect(gun.isActive(), `swarm trial ${i}`).toBe(false);
    }
  }, 60_000);
});

describe("drones against ships", () => {
  test("a drone sinks a transport ship with its troops", async () => {
    const { game, a, b } = await sea();
    structure(game, a, UnitType.Airbase, game.ref(2, 8));
    const boat = b.buildUnit(UnitType.TransportShip, game.ref(13, 8), {
      troops: 5_000,
    });
    order(game, a, UnitType.Drone, boat.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(boat.isActive()).toBe(false);
  });

  test("three hits sink a full-health warship, two don't", async () => {
    expect(3 * droneWarshipDamage(WARSHIP_MAX_HEALTH)).toBeGreaterThanOrEqual(
      WARSHIP_MAX_HEALTH,
    );
    expect(2 * droneWarshipDamage(WARSHIP_MAX_HEALTH)).toBeLessThan(
      WARSHIP_MAX_HEALTH,
    );
    const { game, a, b } = await sea();
    structure(game, a, UnitType.Airbase, game.ref(2, 8));
    // No WarshipExecution: it neither moves nor shoots back.
    const ship = warship(game, b, game.ref(13, 8));
    order(game, a, UnitType.Drone, ship.tile(), { count: 2 });
    executeTicks(game, 3);
    settle(game);
    expect(ship.isActive()).toBe(true);
    expect(ship.health()).toBe(
      WARSHIP_MAX_HEALTH - 2 * droneWarshipDamage(WARSHIP_MAX_HEALTH),
    );
    order(game, a, UnitType.Drone, ship.tile(), { count: 1 });
    executeTicks(game, 3);
    settle(game);
    expect(ship.isActive()).toBe(false);
  });

  test("drones follow a moving warship", async () => {
    const { game, a, b } = await sea();
    structure(game, a, UnitType.Airbase, game.ref(2, 2));
    const ship = warship(game, b, game.ref(12, 1));
    order(game, a, UnitType.Drone, ship.tile(), { count: 1 });
    executeTicks(game, 3);
    const drone = drones(game)[0];
    expect(drone).toBeDefined();
    // The ship sails south one tile a tick; the drone chases it.
    for (let y = 2; y < 15 && drone.isActive(); y++) {
      ship.move(game.ref(12, y));
      executeTicks(game, 1);
    }
    runUntil(game, () => !drone.isActive(), 50);
    expect(drone.reachedTarget()).toBe(true);
    expect(game.y(drone.tile())).toBeGreaterThan(2);
    expect(ship.health()).toBe(
      WARSHIP_MAX_HEALTH - droneWarshipDamage(WARSHIP_MAX_HEALTH),
    );
  });

  test("a drone whose target is gone retargets one nearby, else is lost", async () => {
    const { game, a, b } = await sea();
    structure(game, a, UnitType.Airbase, game.ref(2, 8));
    const first = b.buildUnit(UnitType.TransportShip, game.ref(13, 8), {
      troops: 1_000,
    });
    const second = b.buildUnit(UnitType.TransportShip, game.ref(14, 12), {
      troops: 1_000,
    });
    order(game, a, UnitType.Drone, first.tile(), { count: 1 });
    executeTicks(game, 3);
    first.delete(false);
    settle(game);
    expect(second.isActive()).toBe(false);

    order(game, a, UnitType.Drone, game.ref(13, 3), { count: 1 });
    const third = b.buildUnit(UnitType.TransportShip, game.ref(13, 3), {
      troops: 1_000,
    });
    order(game, a, UnitType.Drone, third.tile(), { count: 1 });
    executeTicks(game, 3);
    third.delete(false);
    settle(game);
    expect(drones(game)).toHaveLength(0);
  });

  test("warships shoot drones down, each shell 50% (seeded)", async () => {
    const { game, a, b } = await sea();
    const ship = warship(game, b, game.ref(10, 8));
    game.addExecution(new WarshipExecution(ship));
    // A drone hanging in range (no execution flies it): the warship keeps
    // shelling it until it falls.
    const parked = a.buildUnit(UnitType.Drone, game.ref(12, 12), {
      targetUnit: ship,
    });
    runUntil(game, () => !parked.isActive(), 300);
    expect(parked.isActive()).toBe(false);
    expect(ship.health()).toBe(WARSHIP_MAX_HEALTH);

    // The roll itself, over many shells at parked drones.
    let downed = 0;
    const shells = 200;
    for (let i = 0; i < shells; i++) {
      const drone = a.buildUnit(UnitType.Drone, game.ref(13, 3), {
        targetUnit: ship,
      });
      game.addExecution(new ShellExecution(ship.tile(), b, ship, drone));
      executeTicks(game, 6);
      if (!drone.isActive()) downed++;
      else drone.delete(false);
    }
    expect(downed / shells).toBeGreaterThan(
      WARSHIP_DRONE_HIT_PERCENT / 100 - 0.12,
    );
    expect(downed / shells).toBeLessThan(
      WARSHIP_DRONE_HIT_PERCENT / 100 + 0.12,
    );
  });
});
