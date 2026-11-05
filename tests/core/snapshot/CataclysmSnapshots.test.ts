import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  RISING_TIDE_FIRST_WAVE_TICKS,
  RISING_TIDE_WARNING_TICKS,
  RISING_TIDE_WAVE_INTERVAL_TICKS,
} from "@openfront/engine-lib/game/RisingTide";
import {
  tilesInRadius,
  VOLCANO_FIRST_RUMBLE_TICKS,
  VOLCANO_WARNING_TICKS,
} from "@openfront/engine-lib/game/Volcanoes";
import { RisingTideExecution } from "@openfront/engine/execution/RisingTideExecution";
import { TradeShipExecution } from "@openfront/engine/execution/TradeShipExecution";
import { VolcanoExecution } from "@openfront/engine/execution/VolcanoExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../../util/Setup";
import { expectSnapshotRoundTrip } from "../../util/Snapshot";

function humans(...names: string[]): PlayerInfo[] {
  return names.map((n) => new PlayerInfo(n, PlayerType.Human, `c_${n}`, n));
}

function runTo(game: Game, tick: number): void {
  while (game.ticks() < tick) game.executeNextTick();
}

describe("volcano snapshots", () => {
  const MAP = "big_plains";

  test("before init, while rumbling, through the eruption and the fallout", async () => {
    const game = await setup(MAP, {}, humans("a"));
    const a = game.player("a");
    const site = game.ref(100, 100);
    for (const t of tilesInRadius(game.map(), site, 30)) a.conquer(t);
    a.setTroops(50_000);
    a.buildUnit(UnitType.City, game.ref(105, 100), {});
    game.addExecution(new VolcanoExecution("snap", [{ x: 100, y: 100 }]));
    // Not initialized yet.
    await expectSnapshotRoundTrip(game, MAP, 3);

    runTo(game, VOLCANO_FIRST_RUMBLE_TICKS + 5);
    // Rumbling: the eruption and its fallout happen after the restore.
    await expectSnapshotRoundTrip(game, MAP, VOLCANO_WARNING_TICKS + 10);
    // Fallout still down, waiting to lift.
    await expectSnapshotRoundTrip(game, MAP, 10);
  }, 60_000);
});

describe("rising tide snapshots", () => {
  // A real water graph (the test config turns it off by default) and ships
  // sailing through the wave, so a restored game must route like the live one.
  const MAP = "world";

  async function tideGame(): Promise<Game> {
    const game = await setup(
      MAP,
      { instantBuild: true, disableNavMesh: false },
      humans("a", "b"),
    );
    const port = (p: Player, x: number, y: number) => {
      for (const t of tilesInRadius(game.map(), game.ref(x, y), 8)) {
        if (game.isLand(t) && !game.hasOwner(t)) p.conquer(t);
      }
      const spawn = p.canBuild(UnitType.Port, game.ref(x, y));
      if (spawn === false) throw new Error("cannot build port");
      return p.buildUnit(UnitType.Port, spawn, {});
    };
    const a = game.player("a");
    const b = game.player("b");
    for (const p of [a, b]) {
      p.setTroops(50_000);
      p.addGold(10_000_000n);
    }
    const src = port(a, 539, 380);
    const dst = port(b, 832, 341);
    game.addExecution(new RisingTideExecution());
    // Ships leave just before the first wave and sail on through it.
    runTo(game, RISING_TIDE_FIRST_WAVE_TICKS - 40);
    game.addExecution(new TradeShipExecution(a, src, dst));
    game.addExecution(new TradeShipExecution(b, dst, src));
    return game;
  }

  test("right after a wave, between waves, and across the next one", async () => {
    const game = await tideGame();
    runTo(game, RISING_TIDE_FIRST_WAVE_TICKS + 1);
    const land = game.numLandTiles();
    expect(land).toBeLessThan(game.map().numLandTiles() + 1);
    // Right after the wave: the flooded tiles are water and the graph is new.
    await expectSnapshotRoundTrip(game, MAP, 40);

    // Between waves, no warning up.
    runTo(game, RISING_TIDE_FIRST_WAVE_TICKS + 600);
    await expectSnapshotRoundTrip(game, MAP, 10);

    // During the next warning, restored games flood the second wave.
    const secondWave =
      RISING_TIDE_FIRST_WAVE_TICKS + RISING_TIDE_WAVE_INTERVAL_TICKS;
    runTo(game, secondWave - RISING_TIDE_WARNING_TICKS + 5);
    const before = game.numLandTiles();
    const restored = await expectSnapshotRoundTrip(
      game,
      MAP,
      secondWave - game.ticks() + 5,
    );
    expect(restored.numLandTiles()).toBeLessThan(before);
    expect(game.numLandTiles()).toBe(restored.numLandTiles());
  }, 120_000);
});
