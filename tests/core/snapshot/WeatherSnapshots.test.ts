import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { WeatherKind } from "@openfront/engine-api/game/GameUpdates";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { WeatherExecution } from "@openfront/engine/execution/WeatherExecution";
import { describe, expect, test } from "vitest";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";
import { executeTicks } from "../../util/utils";

// ocean_and_land: land at x <= 7, open sea, an island at x 14-15, y 6-8.
const MAP = "ocean_and_land";

async function seaGame() {
  const game = await setup(MAP, { infiniteGold: true }, [
    new PlayerInfo("a", PlayerType.Human, null, "a"),
    new PlayerInfo("b", PlayerType.Human, null, "b"),
  ]);
  const a = game.player("a");
  const b = game.player("b");
  game.map().forEachTile((t) => {
    if (!game.isLand(t)) return;
    (game.x(t) <= 7 ? a : b).conquer(t);
  });
  a.setTroops(100_000);
  b.setTroops(1_000);
  return { game, a, b };
}

describe("weather snapshots", () => {
  test("pending, then spawning cells on its seeded schedule", async () => {
    const { game } = await seaGame();
    const weather = new WeatherExecution(1234);
    game.addExecution(weather);
    // Not yet initialized: still queued, and not registered on the game.
    expect(game.weather()).toBeNull();
    await expectSnapshotRoundTrip(game, MAP, 3);
    expect(game.weather()).toBe(weather);
    executeTicks(game, 400);
    expect(weather.cells().length).toBeGreaterThanOrEqual(2);
    const restored = await expectSnapshotRoundTrip(game, MAP, 40);
    // The restored game reads its own restored execution.
    const restoredWeather = restored.weather();
    expect(restoredWeather).not.toBeNull();
    expect(restoredWeather).not.toBe(weather);
    expect(restored.executions()).toContain(restoredWeather);
    expect(restoredWeather!.cells()).toEqual(weather.cells());
  });

  test("mid-storm: slowed ships and drowning boats", async () => {
    const { game, a } = await seaGame();
    const weather = new WeatherExecution(99, false);
    game.addExecution(weather);
    game.executeNextTick();
    weather.addCell({
      id: 1,
      kind: WeatherKind.Storm,
      x: 11,
      y: 8,
      dx: 0.05,
      dy: -0.05,
      radius: 30,
      announceTick: game.ticks(),
      activeTick: game.ticks() + 5,
      endTick: game.ticks() + 120,
    });
    game.addExecution(new TransportShipExecution(a, game.ref(15, 7), 10_000));
    const tile = game.ref(11, 2);
    const warship = a.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
    game.addExecution(new WarshipExecution(warship));
    // A boat sitting in the storm, losing troops up to the cap.
    const boat = a.buildUnit(UnitType.TransportShip, game.ref(10, 12), {
      troops: 8_000,
      targetTile: game.ref(14, 7),
    });
    await expectSnapshotRoundTrip(game, MAP, 4);
    executeTicks(game, 12);
    expect(boat.troops()).toBeLessThan(8_000);
    await expectSnapshotRoundTrip(game, MAP, 40);
    executeTicks(game, 80);
    // Past the end: the storm and its bookkeeping are gone.
    await expectSnapshotRoundTrip(game, MAP, 10);
    expect(weather.cells()).toEqual([]);
  });
});
