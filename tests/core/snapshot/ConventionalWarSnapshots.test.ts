import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { AirMissionExecution } from "@openfront/engine/execution/AirMissionExecution";
import { DroneExecution } from "@openfront/engine/execution/DroneExecution";
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

  test("a moved capital and its move window", async () => {
    const { game, players } = await conventionalGame(BIG, ["a", "b"]);
    const [a, b] = players;
    conquerRect(game, a, 0, 0, 60, 60);
    conquerRect(game, b, 100, 0, 200, 200);
    a.setSpawnTile(game.ref(20, 20));
    b.conquer(game.ref(20, 20));
    expect(a.capitalMovedTick()).not.toBeNull();
    await expectSnapshotRoundTrip(game, BIG, 10);
  });
});
