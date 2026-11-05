/**
 * Replays of the units that fight and get hit: trains a strike catches
 * mid-run, conventional war's planes, drones and missiles, troop convoys,
 * and minefields and coastal batteries against warships. Each game is
 * checked against the live game every tick.
 */

import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { CoastalBatteryExecution } from "@openfront/engine/execution/CoastalBatteryExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
import { MinefieldExecution } from "@openfront/engine/execution/MinefieldExecution";
import { TrainExecution } from "@openfront/engine/execution/TrainExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { Railroad } from "@openfront/engine/game/Railroad";
import { TrainStation } from "@openfront/engine/game/TrainStation";
import { conquerRect, order, structure } from "../../../util/ConventionalWar";
import { setup } from "../../../util/Setup";
import { expectReplayMatches } from "../util/Expect";
import { recordGame, TickScript } from "../util/RecordGame";

function humans(...ids: string[]): PlayerInfo[] {
  return ids.map((id) => new PlayerInfo(id, PlayerType.Human, `c_${id}`, id));
}

/** Every unit type alive on some recorded tick. */
function typesSeen(truth: { units: Map<number, { unitType: string }> }[]) {
  return new Set(
    truth.flatMap((t) => [...t.units.values()].map((u) => u.unitType)),
  );
}

/** A straight rail along row `y` from x 0 to 99, a city at each end. */
function straightRail(game: Game, owner: Player, y: number, id: number) {
  const tiles: TileRef[] = [];
  for (let x = 0; x < 100; x++) tiles.push(game.ref(x, y));
  const [from, to] = [tiles[0], tiles[99]].map(
    (t) => new TrainStation(game, owner.buildUnit(UnitType.City, t, {})),
  );
  const stations = game.railNetwork().stationManager();
  stations.addStation(from);
  stations.addStation(to);
  const railroad = new Railroad(from, to, tiles, id);
  from.addRailroad(railroad);
  to.addRailroad(railroad);
  return { from, to };
}

/** The train on row `y`, engine first, then its cars back to front. */
function trainOnRow(game: Game, owner: Player, y: number): Unit[] {
  return owner
    .units(UnitType.Train)
    .filter((u) => game.y(u.tile()) === y)
    .sort((a, b) => a.id() - b.id());
}

const HIT_TICK = 20;

test("trains hit mid-run: cars outlive their engine, a train loses a car", async () => {
  const game = await setup(
    "big_plains",
    { instantBuild: true },
    humans("alice", "bob"),
  );
  const alice = game.player("alice");
  const bob = game.player("bob");
  // Engine and last car hit after the train moved (a nuke later in the
  // tick), a middle car hit, and an engine hit before the train moved.
  const [afterMove, oneCar, beforeMove] = [40, 100, 160];
  const rails: { from: TrainStation; to: TrainStation }[] = [];
  const strike = (y: number, pick: (train: Unit[]) => Unit[]) =>
    new TickScript((g, tick) => {
      if (tick < HIT_TICK) return false;
      for (const u of pick(trainOnRow(g, alice, y))) u.delete(true, bob);
    });

  const rec = await recordGame(game, {
    ticks: 90,
    skipInit: true,
    beforeTick: (g, t) => {
      if (t === 0) {
        g.addExecution(
          new TickScript(() => {
            conquerRect(g, alice, 0, 30, 100, 170);
            for (const [i, y] of [afterMove, oneCar, beforeMove].entries()) {
              rails.push(straightRail(g, alice, y, i + 1));
            }
          }),
        );
      }
      if (t === 2) {
        g.addExecution(
          // Ticks before the trains.
          strike(beforeMove, (train) => train.slice(0, 1)),
          ...rails.map(
            ({ from, to }) =>
              new TrainExecution(g.railNetwork(), alice, from, to, 3),
          ),
          // Tick after them.
          strike(afterMove, (train) => [train[0], train[4]]),
          strike(oneCar, (train) => [train[3]]),
        );
      }
    },
  });

  // The fixture does what it says: cars outlived their engine for a tick,
  // and a train ran on without one car until it arrived.
  const units = (frame: number, y: number) =>
    [...rec.truth[frame].units.values()].filter(
      (u) => u.unitType === UnitType.Train && game.y(u.pos) === y,
    ).length;
  expect(units(HIT_TICK - 1, afterMove)).toBe(5);
  expect(units(HIT_TICK, afterMove)).toBe(3);
  expect(units(HIT_TICK + 1, afterMove)).toBe(0);
  expect(units(HIT_TICK, oneCar)).toBe(4);
  expect(units(HIT_TICK + 20, oneCar)).toBe(4);
  expect(units(HIT_TICK, beforeMove)).toBe(0);
  expect(units(89, oneCar)).toBe(0);

  expectReplayMatches(rec);
}, 60_000);

test("conventional war: planes, drones, missiles and a convoy round-trip", async () => {
  const game = await setup(
    "big_plains",
    {
      conventionalWar: true,
      infiniteGold: true,
      instantBuild: true,
      donateTroops: true,
    },
    humans("a", "b", "c"),
  );
  const [a, b, c] = ["a", "b", "c"].map((id) => game.player(id));

  const rec = await recordGame(game, {
    ticks: 160,
    skipInit: true,
    beforeTick: (g, t) => {
      if (t === 0) {
        g.addExecution(
          new TickScript(() => {
            // a in the west, its ally c beside it, b in the east.
            conquerRect(g, a, 0, 0, 80, 200);
            conquerRect(g, c, 80, 0, 100, 200);
            conquerRect(g, b, 100, 0, 200, 200);
            a.createAllianceRequest(c)!.accept();
            a.setTroops(200_000);
            for (const y of [40, 100, 160]) {
              structure(g, a, UnitType.Airbase, g.ref(60, y));
            }
            structure(g, a, UnitType.MissileSilo, g.ref(30, 100), 3);
            structure(g, b, UnitType.FlakGun, g.ref(130, 100));
            structure(g, b, UnitType.City, g.ref(160, 100));
            structure(g, b, UnitType.City, g.ref(160, 160));
          }),
        );
      }
      if (t === 2) {
        order(g, a, UnitType.Airstrike, g.ref(130, 40));
        order(g, a, UnitType.Airdrop, g.ref(130, 160), { troops: 20_000 });
        order(g, a, UnitType.Drone, g.ref(130, 100), { count: 2 });
        order(g, a, UnitType.CruiseMissile, g.ref(160, 100));
        order(g, a, UnitType.BallisticMissile, g.ref(160, 160));
        order(g, a, UnitType.ClusterMissile, g.ref(150, 60));
        g.addExecution(new DonateTroopsExecution(a, c.id(), 20_000));
      }
    },
  });

  const seen = typesSeen(rec.truth);
  for (const type of [
    UnitType.Airbase,
    UnitType.FlakGun,
    UnitType.Airstrike,
    UnitType.Airdrop,
    UnitType.Drone,
    UnitType.CruiseMissile,
    UnitType.BallisticMissile,
    UnitType.ClusterMissile,
    UnitType.ClusterWarhead,
    UnitType.Convoy,
  ]) {
    expect(seen, type).toContain(type);
  }
  // And they finished: the flights landed or hit, the convoy arrived.
  const last = typesSeen(rec.truth.slice(-1));
  for (const type of [
    UnitType.Airstrike,
    UnitType.Airdrop,
    UnitType.CruiseMissile,
    UnitType.BallisticMissile,
    UnitType.ClusterMissile,
    UnitType.ClusterWarhead,
    UnitType.Convoy,
  ]) {
    expect(last, type).not.toContain(type);
  }

  expectReplayMatches(rec);
}, 60_000);

test("normal game: minefields and coastal batteries against warships round-trip", async () => {
  // half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15.
  const game = await setup(
    "half_land_half_ocean",
    { infiniteGold: true, instantBuild: true },
    humans("a", "b"),
  );
  const [a, b] = ["a", "b"].map((id) => game.player(id));
  let field: Unit | null = null;
  let battery: Unit | null = null;

  const rec = await recordGame(game, {
    ticks: 220,
    skipInit: true,
    beforeTick: (g, t) => {
      if (t === 0) {
        g.addExecution(
          new TickScript(() => {
            conquerRect(g, a, 4, 0, 8, 16);
            conquerRect(g, b, 0, 0, 2, 16);
            field = a.buildUnit(UnitType.Minefield, g.ref(12, 8), {
              density: 100,
            });
            // Structures keep 15 tiles apart: a battery at each end.
            battery = a.buildUnit(UnitType.CoastalBattery, g.ref(7, 15), {});
            g.addExecution(
              new MinefieldExecution(field),
              new CoastalBatteryExecution(battery),
              new ConstructionExecution(
                a,
                UnitType.CoastalBattery,
                g.ref(7, 0),
              ),
            );
          }),
        );
      }
      // Past spawn immunity, so the warships fight.
      if (t === 50) {
        g.addExecution(
          new TickScript(() => {
            for (const tile of [g.ref(11, 3), g.ref(13, 12)]) {
              g.addExecution(
                new WarshipExecution(
                  b.buildUnit(UnitType.Warship, tile, { patrolTile: tile }),
                ),
              );
            }
          }),
        );
      }
    },
  });

  const seen = typesSeen(rec.truth);
  for (const type of [
    UnitType.Minefield,
    UnitType.CoastalBattery,
    UnitType.Warship,
    UnitType.Shell,
  ]) {
    expect(seen, type).toContain(type);
  }
  // It did fight: mines went off and the battery took hits.
  expect(field!.health()).toBeLessThan(100);
  expect(battery!.health()).toBeLessThan(battery!.maxHealth());

  expectReplayMatches(rec);
}, 60_000);
