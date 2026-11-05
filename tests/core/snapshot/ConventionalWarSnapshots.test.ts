import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { BALLISTIC_MISSILE_COST } from "@openfront/engine-lib/game/ConventionalWar";
import { AirMissionExecution } from "@openfront/engine/execution/AirMissionExecution";
import { DroneExecution } from "@openfront/engine/execution/DroneExecution";
import { NationNukeBehaviorSnapshot } from "@openfront/engine/execution/nation/NationNukeBehavior";
import { PlayerSnapshot } from "@openfront/engine/game/PlayerImpl";
import { UnitSnapshot } from "@openfront/engine/game/UnitImpl";
import {
  conquerRect,
  conventionalGame,
  order,
  structure,
} from "../../util/ConventionalWar";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

const BIG = "big_plains";

describe("conventional war snapshots", () => {
  test("every flight in the air, pending and mid-split, with SAMs and flak firing", async () => {
    const { game, players } = await conventionalGame(BIG, ["a", "b"], {
      infiniteGold: true,
    });
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 60, 200);
    conquerRect(game, b, 100, 0, 200, 200);
    a.setTroops(300_000);
    structure(game, a, UnitType.Airbase, game.ref(50, 40));
    structure(game, a, UnitType.Airbase, game.ref(50, 100));
    structure(game, a, UnitType.Airbase, game.ref(50, 160));
    for (const y of [20, 60, 100, 140, 180]) {
      structure(game, a, UnitType.MissileSilo, game.ref(10, y), 3);
    }
    structure(game, b, UnitType.SAMLauncher, game.ref(150, 60));
    structure(game, b, UnitType.SAMLauncher, game.ref(150, 140), 2);
    const flak = structure(game, b, UnitType.FlakGun, game.ref(120, 100));
    structure(game, b, UnitType.DefensePost, game.ref(130, 40));
    structure(game, b, UnitType.City, game.ref(170, 100));

    order(game, a, UnitType.Airstrike, game.ref(130, 40));
    order(game, a, UnitType.Airdrop, game.ref(140, 100), { troops: 20_000 });
    order(game, a, UnitType.CruiseMissile, game.ref(150, 60));
    order(game, a, UnitType.BallisticMissile, game.ref(170, 100));
    order(game, a, UnitType.ClusterMissile, game.ref(150, 140));
    order(game, a, UnitType.Drone, flak.tile(), { count: 6 });
    // A pending flight (not yet initialized) and a homing drone.
    game.addExecution(
      new AirMissionExecution(UnitType.Airstrike, a, game.ref(160, 160)),
    );
    const drone = a.buildUnit(UnitType.Drone, game.ref(70, 100), {
      targetUnit: flak,
    });
    game.addExecution(new DroneExecution(drone));

    await expectSnapshotRoundTrip(game, BIG, 1);
    executeTicks(game, 4);
    expect(game.units(UnitType.Airstrike).length).toBeGreaterThan(0);
    expect(game.units(UnitType.Drone).length).toBeGreaterThan(0);
    await expectSnapshotRoundTrip(game, BIG, 40);
    // Mid-fight: warheads split off, flak rounds reloading.
    executeTicks(game, 6);
    await expectSnapshotRoundTrip(game, BIG, 60);
  }, 60_000);

  test("a lost capital's penalty window, a spent rally and drone hits", async () => {
    const { game, players } = await conventionalGame(BIG, ["a", "b"]);
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 60, 60);
    conquerRect(game, b, 100, 0, 200, 200);
    a.setSpawnTile(game.ref(20, 20));
    b.setSpawnTile(game.ref(150, 100));
    b.conquer(game.ref(20, 20));
    expect(a.capitalPenaltyTick()).not.toBeNull();
    // b's capital held by a, a's own retaken once.
    a.conquer(game.ref(150, 100));
    a.conquer(game.ref(20, 20));
    expect(a.capitalRallyUsed()).toBe(true);
    const city = structure(game, b, UnitType.City, game.ref(170, 100));
    city.addDroneHit();
    await expectSnapshotRoundTrip(game, BIG, 10);
  });
});

describe("conventional war snapshot migrations", () => {
  test("player v3: the moved capital is dropped, its window guards the penalty", () => {
    // v2 -> v3 added the city-state flags (world features), v3 -> v4 the
    // capital rework.
    const v3 = {
      other: 1,
      capitalTile: 1234,
      capitalMovedTick: 900,
      isCityState: false,
      cityStateBountyTaken: false,
    };
    expect(PlayerSnapshot.version).toBe(4);
    expect(PlayerSnapshot.migrations[3](v3)).toEqual({
      other: 1,
      capitalPenaltyTick: 900,
      capitalRallyUsed: false,
      isCityState: false,
      cityStateBountyTaken: false,
    });
    expect(
      PlayerSnapshot.migrations[3]({
        capitalTile: null,
        capitalMovedTick: null,
        isCityState: true,
        cityStateBountyTaken: true,
      }),
    ).toEqual({
      capitalPenaltyTick: null,
      capitalRallyUsed: false,
      isCityState: true,
      cityStateBountyTaken: true,
    });
    // v1 goes through v2 and v3 first.
    expect(
      PlayerSnapshot.migrations[3](
        PlayerSnapshot.migrations[2](
          PlayerSnapshot.migrations[1]({ other: 2 }),
        ),
      ),
    ).toEqual({
      other: 2,
      capitalPenaltyTick: null,
      capitalRallyUsed: false,
      isCityState: false,
      cityStateBountyTaken: false,
    });
  });

  test("player v3 as the gameplay-updates branch wrote it on its own", () => {
    // That branch bumped v2 to v3 with the capital fields and no city-states.
    expect(
      PlayerSnapshot.migrations[3]({
        other: 3,
        capitalPenaltyTick: 700,
        capitalRallyUsed: true,
      }),
    ).toEqual({
      other: 3,
      capitalPenaltyTick: 700,
      capitalRallyUsed: true,
      isCityState: false,
      cityStateBountyTaken: false,
    });
  });

  test("nation nukes v2: no ballistic missile launched yet", () => {
    expect(NationNukeBehaviorSnapshot.version).toBe(3);
    expect(NationNukeBehaviorSnapshot.migrations[2]({ other: 1 })).toEqual({
      other: 1,
      ballisticPerceivedCost: BigInt(BALLISTIC_MISSILE_COST),
      ballisticLastLaunch: null,
    });
  });

  test("unit v2: no drone hits yet", () => {
    expect(UnitSnapshot.version).toBe(3);
    expect(UnitSnapshot.migrations[2]({ other: 1 })).toEqual({
      other: 1,
      droneHits: 0,
    });
  });
});
