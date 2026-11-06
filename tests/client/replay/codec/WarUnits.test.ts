/**
 * Replays of the units that travel and get hit: trains a strike catches
 * mid-run, and troop convoys over land and by sea. Each game is checked
 * against the live game every tick.
 */

import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
import { TrainExecution } from "@openfront/engine/execution/TrainExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { Railroad } from "@openfront/engine/game/Railroad";
import { TrainStation } from "@openfront/engine/game/TrainStation";
import { conquerRect } from "../../../util/ConventionalWar";
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

test("troop convoys over land and by sea round-trip", async () => {
  // World map: Mozambique's coast, with Madagascar about 40 tiles of sea to
  // the east and unowned land between the sender and its inland ally.
  const game = await setup(
    "world",
    { donateTroops: true },
    humans("sender", "inland", "island"),
  );
  const [sender, inland, island] = ["sender", "inland", "island"].map((id) =>
    game.player(id),
  );

  const rec = await recordGame(game, {
    ticks: 160,
    keyframeInterval: 50,
    skipInit: true,
    // The map is 2M tiles; sample them now and then.
    tileTruthEvery: 53,
    beforeTick: (g, t) => {
      if (t === 0) {
        g.addExecution(
          new TickScript(() => {
            conquerRect(g, sender, 1110, 636, 1145, 650);
            conquerRect(g, inland, 1060, 636, 1090, 650);
            conquerRect(g, island, 1170, 636, 1190, 650);
            sender.createAllianceRequest(inland)!.accept();
            sender.createAllianceRequest(island)!.accept();
            sender.setTroops(100_000);
            inland.setTroops(0);
            island.setTroops(0);
          }),
        );
      }
      if (t === 2) {
        g.addExecution(
          new DonateTroopsExecution(sender, inland.id(), 20_000),
          new DonateTroopsExecution(sender, island.id(), 20_000),
        );
      }
    },
  });

  // Two convoys: the inland one stayed on land, the island one went to sea.
  const atSea = new Map<number, boolean>();
  for (const frame of rec.truth) {
    for (const [id, u] of frame.units) {
      if (u.unitType !== UnitType.Convoy) continue;
      atSea.set(id, (atSea.get(id) ?? false) || game.isWater(u.pos));
    }
  }
  expect([...atSea.values()].sort()).toEqual([false, true]);
  // And both arrived.
  expect(typesSeen(rec.truth.slice(-1))).not.toContain(UnitType.Convoy);
  expect(inland.troops()).toBeGreaterThanOrEqual(20_000);
  expect(island.troops()).toBeGreaterThanOrEqual(20_000);

  expectReplayMatches(rec);
}, 120_000);
