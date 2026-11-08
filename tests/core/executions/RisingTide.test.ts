import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  RisingTideUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import {
  RISING_TIDE_FIRST_WAVE_TICKS,
  RISING_TIDE_MIN_ISLAND_FLOOR,
  RISING_TIDE_MIN_ISLAND_MAX,
  RISING_TIDE_MAX_TILES_PER_WAVE,
  RISING_TIDE_STOP_PERCENT,
  RISING_TIDE_WARNING_TICKS,
  RISING_TIDE_WAVE_INTERVAL_TICKS,
  RISING_TIDE_WAVE_PERCENT,
  risingTideIslandTiles,
  risingTideMinIsland,
  risingTidePlanWave,
  risingTideScheduledBudget,
  risingTideTroopsLost,
  risingTideWaveBudget,
  risingTideWaveTiles,
} from "@openfront/engine-lib/game/RisingTide";
import {
  isNextToFlood,
  RisingTideExecution,
} from "@openfront/engine/execution/RisingTideExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  createScriptedRunner,
  scriptedGameStart,
} from "../../util/ScriptedGame";
import { setup } from "../../util/Setup";

const OCEAN = 0x20;
const LAND = 0x80;

describe("risingTideWaveTiles", () => {
  // Row 0 is ocean; the land below has these magnitudes.
  const MAGNITUDES = [
    [5, 2, 7, 1, 9, 3],
    [0, 8, 1, 6, 2, 4],
    [9, 9, 9, 0, 9, 9],
  ];
  function strip(): GameMapImpl {
    const w = 6;
    const terrain = new Uint8Array(w * 4).fill(OCEAN);
    MAGNITUDES.forEach((row, y) =>
      row.forEach((m, x) => (terrain[(y + 1) * w + x] = LAND | m)),
    );
    return new GameMapImpl(w, 4, terrain, 18);
  }

  test("floods the lowest land next to the ocean first, rising inland", () => {
    // Coast row: 1 (x3) floods, then 2 (x1), 3 (x5). Flooding x5 makes the 4
    // behind it coastal, and then the 2 behind that, before the coast's 5.
    expect(risingTideWaveTiles(strip(), 5)).toEqual([9, 7, 11, 17, 16]);
  });

  test("ties go to the lower tile index", () => {
    const w = 4;
    const terrain = new Uint8Array(w * 2).fill(OCEAN);
    for (let x = 0; x < w; x++) terrain[w + x] = LAND | 3;
    const map = new GameMapImpl(w, 2, terrain, 4);
    expect(risingTideWaveTiles(map, 3)).toEqual([4, 5, 6]);
  });

  test("never floods impassable land or land not reached from the ocean", () => {
    const w = 3;
    // ocean, then impassable, then land walled off by it.
    const terrain = new Uint8Array([
      OCEAN,
      OCEAN,
      OCEAN,
      LAND | 31,
      LAND | 31,
      LAND | 31,
      LAND | 0,
      LAND | 0,
      LAND | 0,
    ]);
    const map = new GameMapImpl(w, 3, terrain, 6);
    expect(risingTideWaveTiles(map, 10)).toEqual([]);
  });

  test("flooded troops fall back to the land left, up to its cap", () => {
    // 1,000 on the flooded tiles of 10,000; the land left holds 9,500.
    expect(risingTideTroopsLost(10_000, 1_000, 9_500)).toBe(500);
    expect(risingTideTroopsLost(10_000, 1_000, 20_000)).toBe(0);
    // Never more than stood on the flooded land.
    expect(risingTideTroopsLost(10_000, 1_000, 2_000)).toBe(1_000);
  });

  test("the per-wave budget: 4% of the original land, capped, down to 40%", () => {
    expect(RISING_TIDE_WAVE_PERCENT).toBe(4);
    expect(RISING_TIDE_STOP_PERCENT).toBe(40);
    expect(risingTideWaveBudget(1000, 1000)).toBe(40);
    expect(risingTideWaveBudget(1000, 420)).toBe(20);
    expect(risingTideWaveBudget(1000, 400)).toBe(0);
    expect(risingTideWaveBudget(1000, 300)).toBe(0);
    expect(risingTideWaveBudget(10_000_000, 10_000_000)).toBe(
      RISING_TIDE_MAX_TILES_PER_WAVE,
    );
    // A tiny map still floods a tile a wave.
    expect(risingTideWaveBudget(10, 10)).toBe(1);
  });
});

const MAP = "half_land_half_ocean";

/** One tick, returning its tide update if it sent one. */
function step(game: Game): RisingTideUpdate | undefined {
  const updates = game.executeNextTick()[GameUpdateType.Cataclysm];
  return (updates as RisingTideUpdate[]).find((u) => u.kind === "tide");
}

function runTo(game: Game, tick: number): void {
  while (game.ticks() < tick) step(game);
}

function landTiles(game: Game): TileRef[] {
  const out: TileRef[] = [];
  game.forEachTile((t) => {
    if (game.isLand(t) && !game.isImpassable(t)) out.push(t);
  });
  return out;
}

describe("risingTideIslandTiles: no tiny islands left behind", () => {
  // Row 0 is ocean; the land below has these magnitudes (as in the
  // risingTideWaveTiles strip). Flooding 5 tiles cuts off tile 10.
  const MAGNITUDES = [
    [5, 2, 7, 1, 9, 3],
    [0, 8, 1, 6, 2, 4],
    [9, 9, 9, 0, 9, 9],
  ];
  function strip(override?: (x: number, y: number) => number | null) {
    const w = 6;
    const terrain = new Uint8Array(w * 4).fill(OCEAN);
    MAGNITUDES.forEach((row, y) =>
      row.forEach(
        (m, x) => (terrain[(y + 1) * w + x] = LAND | (override?.(x, y) ?? m)),
      ),
    );
    return new GameMapImpl(w, 4, terrain, 18);
  }

  test("a tile the wave cuts off floods with it; the big piece stays", () => {
    const map = strip();
    const wave = risingTideWaveTiles(map, 5);
    expect(wave).toEqual([9, 7, 11, 17, 16]);
    // Tile 10 is left with water on all four sides; the other 13 tiles stay
    // joined.
    expect(risingTideIslandTiles(map, wave, 8)).toEqual([10]);
  });

  test("a piece smaller than the minimum goes under whole", () => {
    const map = strip();
    const wave = risingTideWaveTiles(map, 5);
    const islands = risingTideIslandTiles(map, wave, 14);
    expect(new Set(islands)).toEqual(
      new Set([10, 6, 12, 8, 14, 13, 15, 18, 19, 20, 21, 22, 23]),
    );
  });

  test("impassable tiles count toward a piece but never flood", () => {
    // Tile 10 (x4, y0 of the land) made impassable: still cut off, not flooded.
    const map = strip((x, y) => (x === 4 && y === 0 ? 31 : null));
    expect(risingTideIslandTiles(map, [9, 7, 11, 17, 16], 8)).toEqual([]);
  });

  test("land the wave doesn't touch is left alone", () => {
    const w = 7;
    // Ocean all round; a one-tile island at x1 and a coast at x4..x6.
    const terrain = new Uint8Array(w * 3).fill(OCEAN);
    terrain[w + 1] = LAND | 9;
    for (let y = 0; y < 3; y++) {
      for (let x = 4; x < 7; x++) terrain[y * w + x] = LAND | 5;
    }
    const map = new GameMapImpl(w, 3, terrain, 10);
    // The wave takes one coastal tile; the lone island isn't next to it.
    expect(risingTideIslandTiles(map, [w + 4], 8)).toEqual([]);
  });

  test("a big piece reached from several sides is measured once and kept", () => {
    const w = 12;
    const terrain = new Uint8Array(w * 5).fill(OCEAN);
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 11; x++) terrain[y * w + x] = LAND | 5;
    }
    const map = new GameMapImpl(w, 5, terrain, 30);
    // Flood the whole top row of the block: the rest touches it many times.
    const wave = [];
    for (let x = 1; x < 11; x++) wave.push(w + x);
    expect(risingTideIslandTiles(map, wave, 8)).toEqual([]);
  });

  test("a planned wave is the flood plus the islands it cuts off", () => {
    const map = strip();
    expect(risingTidePlanWave(map, 5, 8)).toEqual([9, 7, 11, 17, 16, 10]);
  });

  test("the schedule takes extra island tiles back out of the next wave", () => {
    // 1000 tiles of land: a normal wave is 40.
    expect(risingTideScheduledBudget(1000, 1000, 0)).toBe(40);
    // On schedule after one wave.
    expect(risingTideScheduledBudget(1000, 960, 1)).toBe(40);
    // The first wave also flooded 10 tiles of islands: the next floods 30.
    expect(risingTideScheduledBudget(1000, 950, 1)).toBe(30);
    // Far ahead: never below half a wave.
    expect(risingTideScheduledBudget(1000, 900, 1)).toBe(20);
    // Behind: never more than a normal wave.
    expect(risingTideScheduledBudget(1000, 990, 1)).toBe(40);
    // Done at the 40% floor, and the floor still binds.
    expect(risingTideScheduledBudget(1000, 400, 15)).toBe(0);
    expect(risingTideScheduledBudget(1000, 410, 14)).toBe(10);
  });

  test("the minimum scales with the map: 8 tiles up to 400", () => {
    expect(risingTideMinIsland(18)).toBe(RISING_TIDE_MIN_ISLAND_FLOOR);
    expect(risingTideMinIsland(651_569)).toBe(130);
    expect(risingTideMinIsland(5_000_000)).toBe(RISING_TIDE_MIN_ISLAND_MAX);
  });
});

describe("RisingTideExecution", () => {
  let game: Game;
  let owner: Player;
  let originalLand: number;

  beforeEach(async () => {
    game = await setup(MAP, {}, [
      new PlayerInfo("owner", PlayerType.Human, "c_owner", "owner"),
    ]);
    owner = game.player("owner");
    for (const t of landTiles(game)) owner.conquer(t);
    owner.setTroops(128_000);
    originalLand = game.numLandTiles();
    game.addExecution(new RisingTideExecution());
  });

  test("warns 30 s ahead with the tiles it floods, then floods exactly them", () => {
    const first = step(game);
    expect(first?.nextWaveTick).toBe(RISING_TIDE_FIRST_WAVE_TICKS);
    expect(first?.warningTiles).toEqual([]);
    expect(first?.originalLand).toBe(originalLand);

    const warnAt = RISING_TIDE_FIRST_WAVE_TICKS - RISING_TIDE_WARNING_TICKS;
    runTo(game, warnAt);
    const warning = step(game)!;
    const expected = risingTideWaveTiles(
      game.map(),
      risingTideWaveBudget(originalLand, originalLand),
    );
    expect(warning.warningTiles).toEqual(expected);
    expect(warning.warningTiles).toHaveLength(
      Math.floor((originalLand * RISING_TIDE_WAVE_PERCENT) / 100),
    );
    for (const t of expected) expect(isNextToFlood(game, t)).toBe(true);

    // A structure on a tile about to flood, and one that stays dry.
    const doomed = owner.buildUnit(UnitType.City, expected[0], {});
    const dry = landTiles(game).find((t) => !expected.includes(t))!;
    const safe = owner.buildUnit(UnitType.DefensePost, dry, {});
    // A convoy on land about to flood goes under; a ship at sea sails on.
    const convoy = owner.buildUnit(UnitType.Convoy, expected[1], {
      troops: 100,
      targetTile: dry,
      targetPlayer: owner,
    });
    let ocean = -1;
    game.forEachTile((t) => {
      if (ocean < 0 && game.isOcean(t)) ocean = t;
    });
    const ship = owner.buildUnit(UnitType.Warship, ocean, {
      patrolTile: ocean,
    });

    runTo(game, RISING_TIDE_FIRST_WAVE_TICKS);
    const tilesBefore = owner.numTilesOwned();
    const troopsBefore = owner.troops();
    const wave = step(game)!;
    expect(wave.wave).toBe(1);
    expect(wave.warningTiles).toEqual([]);
    expect(wave.nextWaveTick).toBe(
      RISING_TIDE_FIRST_WAVE_TICKS + RISING_TIDE_WAVE_INTERVAL_TICKS,
    );
    for (const t of expected) {
      expect(game.isWater(t)).toBe(true);
      expect(game.hasOwner(t)).toBe(false);
      expect(isNextToFlood(game, t)).toBe(false);
    }
    expect(game.numLandTiles()).toBe(originalLand - expected.length);
    expect(owner.numTilesOwned()).toBe(tilesBefore - expected.length);
    expect(doomed.isActive()).toBe(false);
    expect(safe.isActive()).toBe(true);
    expect(convoy.isActive()).toBe(false);
    expect(ship.isActive()).toBe(true);
    // The troops on the flooded tiles fall back: the land left still holds
    // them all under its cap.
    expect(troopsBefore).toBeLessThan(game.config().maxTroops(owner));
    expect(owner.troops()).toBe(troopsBefore);
  });

  test("troops fall back only up to the cap of the land left", () => {
    owner.setTroops(game.config().maxTroops(owner));
    runTo(game, RISING_TIDE_FIRST_WAVE_TICKS);
    const tilesBefore = owner.numTilesOwned();
    const troopsBefore = owner.troops();
    step(game);
    const flooded = tilesBefore - owner.numTilesOwned();
    expect(flooded).toBeGreaterThan(0);
    const cap = game.config().maxTroops(owner);
    // What the land left cannot hold is lost, far less than the old
    // troops-per-tile share of the flooded land.
    expect(Math.abs(owner.troops() - cap)).toBeLessThan(1);
    expect(troopsBefore - owner.troops()).toBeLessThan(
      (troopsBefore * flooded) / tilesBefore / 2,
    );
  });

  test("every wave floods at most its share, and the tide stops at 40% of the land", () => {
    const perWave = risingTideWaveBudget(originalLand, originalLand);
    const floor = Math.ceil((originalLand * RISING_TIDE_STOP_PERCENT) / 100);
    let land = game.numLandTiles();
    let waves = 0;
    const exec = game
      .executions()
      .find((e) => e instanceof RisingTideExecution)!;
    while (exec.isActive() && game.ticks() < 200_000) {
      step(game);
      const now = game.numLandTiles();
      if (now !== land) {
        waves++;
        expect(land - now).toBeLessThanOrEqual(perWave);
        land = now;
      }
    }
    expect(exec.isActive()).toBe(false);
    expect(game.numLandTiles()).toBe(floor);
    expect(waves).toBe(Math.ceil((originalLand - floor) / perWave));
    // Nothing more floods once it has stopped.
    runTo(game, game.ticks() + 2 * RISING_TIDE_WAVE_INTERVAL_TICKS);
    expect(game.numLandTiles()).toBe(floor);
  });

  test("a map with no ocean has nothing to flood", async () => {
    const plains = await setup("plains");
    const exec = new RisingTideExecution();
    plains.addExecution(exec);
    runTo(plains, RISING_TIDE_FIRST_WAVE_TICKS);
    expect(exec.isActive()).toBe(false);
    expect(plains.numLandTiles()).toBe(10_000);
  });
});

describe("rising tide lobby setting", () => {
  test("off by default: no tide execution runs", async () => {
    const off = await createScriptedRunner("world", scriptedGameStart());
    expect(off.game.config().risingTide()).toBe(false);
    expect(
      off.game.executions().some((e) => e instanceof RisingTideExecution),
    ).toBe(false);

    const on = await createScriptedRunner(
      "world",
      scriptedGameStart({ risingTide: true }),
    );
    expect(on.game.config().risingTide()).toBe(true);
    expect(
      on.game.executions().some((e) => e instanceof RisingTideExecution),
    ).toBe(true);
  });
});
