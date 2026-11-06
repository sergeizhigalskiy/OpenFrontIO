import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Cell,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  TerrainType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import {
  FOREST_DEFENDED_LOSS_MULTIPLIER,
  FOREST_TIME_MULTIPLIER,
  packTerrainFeatures,
  RIVER_LOSS_MULTIPLIER,
  RIVER_TIME_MULTIPLIER,
  terrainFeatureAllowsStructures,
  terrainFeatureAt,
  terrainFeatureLossMultiplier,
  terrainFeaturesByteLength,
  terrainFeatureTimeMultiplier,
  unpackTerrainFeatures,
} from "@openfront/engine-lib/game/TerrainFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  AttackLogicInput,
  AttackLogicResult,
  EngineConfig,
} from "@openfront/engine/configuration/EngineConfig";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { Game, Player } from "@openfront/engine/game/Game";
import { createGame } from "@openfront/engine/game/GameImpl";
import { TestConfig, UseRealAttackLogic } from "./util/TestConfig";
import { executeTicks } from "./util/utils";

const LAND_PLAINS = 0b10000000; // isLand=1, magnitude=0
const LAND_MOUNTAIN = 0b10011000; // isLand=1, magnitude=24

const MAP_W = 64;
const MAP_H = 20;
/** The attacker starts on x < FRONT_X; everything else is the target's. */
const FRONT_X = 10;

/** A fixed per-tile cost, so the feature multipliers are all that varies. */
const FLAT_LOSS = 10;
const FLAT_TICK_FRACTION = 0.125; // 8 plain tiles per tick
class FlatAttackConfig extends TestConfig {
  attackLogic(_input: AttackLogicInput): AttackLogicResult {
    return {
      attackerTroopLoss: FLAT_LOSS,
      defenderTroopLoss: 0,
      tickFraction: FLAT_TICK_FRACTION,
    };
  }
}

function featureLayer(
  width: number,
  height: number,
  at: (x: number, y: number) => TerrainFeature,
): Uint8Array {
  const features: TerrainFeature[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) features.push(at(x, y));
  }
  return packTerrainFeatures(features);
}

function setupGame(
  feature: TerrainFeature | null,
  ConfigClass: typeof EngineConfig = FlatAttackConfig,
  terrainByte = LAND_PLAINS,
): Game {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  const terrain = new Uint8Array(MAP_W * MAP_H).fill(terrainByte);
  const features =
    feature === null
      ? null
      : featureLayer(MAP_W, MAP_H, (x) =>
          x >= FRONT_X ? feature : TerrainFeature.None,
        );
  const gameMap = new GameMapImpl(
    MAP_W,
    MAP_H,
    terrain,
    MAP_W * MAP_H,
    features,
  );
  const miniMap = new GameMapImpl(
    MAP_W / 2,
    MAP_H / 2,
    new Uint8Array((MAP_W / 2) * (MAP_H / 2)).fill(terrainByte),
    (MAP_W / 2) * (MAP_H / 2),
  );
  const gameConfig: GameConfig = {
    gameMap: GameMapType.Asia,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: "default",
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: true,
    infiniteTroops: false,
    instantBuild: true,
    randomSpawn: false,
  };
  const game = createGame(
    [
      new PlayerInfo("attacker", PlayerType.Human, "c1", "attacker_id"),
      new PlayerInfo("defender", PlayerType.Human, "c2", "defender_id"),
    ],
    [],
    gameMap,
    miniMap,
    new ConfigClass(gameConfig, false),
  );
  game.endSpawnPhase();
  return game;
}

/**
 * Runs `ticks` ticks of a 1000-troop attack from the left strip into the rest
 * of the map, owned by the defender or left unowned, and reports the tiles
 * taken and the attacker's troops lost per tile.
 */
function runAttack(
  feature: TerrainFeature | null,
  defended: boolean,
  ConfigClass: typeof EngineConfig = FlatAttackConfig,
  ticks = 4,
): { tiles: number; lossPerTile: number } {
  const game = setupGame(feature, ConfigClass);
  const attacker = game.player("attacker_id");
  const defender = game.player("defender_id");
  for (let x = 0; x < MAP_W; x++) {
    for (let y = 0; y < MAP_H; y++) {
      if (x < FRONT_X) attacker.conquer(game.ref(x, y));
      else if (defended) defender.conquer(game.ref(x, y));
    }
  }
  const startTiles = attacker.numTilesOwned();
  const target = defended ? defender.id() : game.terraNullius().id();
  game.addExecution(new AttackExecution(1000, attacker, target, null, false));
  executeTicks(game, ticks);
  const attack = attacker.outgoingAttacks()[0];
  const tiles = attacker.numTilesOwned() - startTiles;
  return { tiles, lossPerTile: (1000 - attack.troops()) / tiles };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Terrain feature rules", () => {
  test("multipliers", () => {
    expect(FOREST_DEFENDED_LOSS_MULTIPLIER).toBe(1.2);
    expect(FOREST_TIME_MULTIPLIER).toBe(1.2);
    expect(RIVER_LOSS_MULTIPLIER).toBe(1.25);
    expect(RIVER_TIME_MULTIPLIER).toBe(2);

    const loss = (f: TerrainFeature, defended: boolean) =>
      terrainFeatureLossMultiplier(f, defended);
    expect(loss(TerrainFeature.None, true)).toBe(1);
    expect(loss(TerrainFeature.Forest, true)).toBe(1.2);
    expect(loss(TerrainFeature.Forest, false)).toBe(1);
    expect(loss(TerrainFeature.River, true)).toBe(1.25);
    expect(loss(TerrainFeature.River, false)).toBe(1.25);
    expect(loss(TerrainFeature.Ford, true)).toBe(1);
    expect(loss(TerrainFeature.Ford, false)).toBe(1);

    expect(terrainFeatureTimeMultiplier(TerrainFeature.None)).toBe(1);
    expect(terrainFeatureTimeMultiplier(TerrainFeature.Forest)).toBe(1.2);
    expect(terrainFeatureTimeMultiplier(TerrainFeature.River)).toBe(2);
    expect(terrainFeatureTimeMultiplier(TerrainFeature.Ford)).toBe(1);
  });

  test("no structures on rivers or fords", () => {
    expect(terrainFeatureAllowsStructures(TerrainFeature.None)).toBe(true);
    expect(terrainFeatureAllowsStructures(TerrainFeature.Forest)).toBe(true);
    expect(terrainFeatureAllowsStructures(TerrainFeature.River)).toBe(false);
    expect(terrainFeatureAllowsStructures(TerrainFeature.Ford)).toBe(false);
  });

  test("packed layout matches the map generator's (features_test.go)", () => {
    const N = TerrainFeature.None;
    const F = TerrainFeature.Forest;
    const R = TerrainFeature.River;
    const D = TerrainFeature.Ford;
    // Same 4x2 grid as TestPackFeaturesLayout, row-major.
    const grid = [F, R, D, N, N, D, F, R];
    const packed = packTerrainFeatures(grid);
    expect([...packed]).toEqual([
      1 | (2 << 2) | (3 << 4),
      (3 << 2) | (1 << 4) | (2 << 6),
    ]);
    grid.forEach((f, ref) => expect(terrainFeatureAt(packed, ref)).toBe(f));
    expect([...unpackTerrainFeatures(packed, grid.length)]).toEqual(grid);
    expect(terrainFeaturesByteLength(8)).toBe(2);
    expect(terrainFeaturesByteLength(9)).toBe(3);
  });
});

describe("GameMapImpl feature layer", () => {
  test("maps without a layer have no features", () => {
    const map = new GameMapImpl(4, 4, new Uint8Array(16).fill(LAND_PLAINS), 16);
    map.forEachTile((t) =>
      expect(map.terrainFeature(t)).toBe(TerrainFeature.None),
    );
  });

  test("reads the feature of each tile", () => {
    const layer = featureLayer(4, 4, (x, y) => (x + y) % 4);
    const map = new GameMapImpl(
      4,
      4,
      new Uint8Array(16).fill(LAND_PLAINS),
      16,
      layer,
    );
    expect(map.terrainFeature(map.ref(1, 0))).toBe(TerrainFeature.Forest);
    expect(map.terrainFeature(map.ref(1, 1))).toBe(TerrainFeature.River);
    expect(map.terrainFeature(map.ref(3, 0))).toBe(TerrainFeature.Ford);
    expect(map.terrainFeature(map.ref(2, 2))).toBe(TerrainFeature.None);
    // Features leave the terrain alone.
    expect(map.terrainType(map.ref(1, 1))).toBe(TerrainType.Plains);
    expect(map.isLand(map.ref(1, 1))).toBe(true);
  });

  test("a layer of the wrong size fails", () => {
    expect(
      () => new GameMapImpl(4, 4, new Uint8Array(16), 0, new Uint8Array(3)),
    ).toThrow(/Feature layer length/);
  });

  test("a snapshot only restores onto the same feature layer", () => {
    const terrain = () => new Uint8Array(16).fill(LAND_PLAINS);
    const forest = () => featureLayer(4, 4, () => TerrainFeature.Forest);
    const river = featureLayer(4, 4, () => TerrainFeature.River);
    const snap = new GameMapImpl(4, 4, terrain(), 16, forest()).snapshot();
    expect(() =>
      new GameMapImpl(4, 4, terrain(), 16, forest()).restoreSnapshot(snap),
    ).not.toThrow();
    expect(() =>
      new GameMapImpl(4, 4, terrain(), 16, river).restoreSnapshot(snap),
    ).toThrow(/map file differs/);
    expect(() =>
      new GameMapImpl(4, 4, terrain(), 16).restoreSnapshot(snap),
    ).toThrow(/map file differs/);
  });

  test("maps without a layer hash as before", () => {
    // The terrain-only hash every snapshot taken before feature layers used.
    const data = new Uint8Array(16).fill(LAND_PLAINS);
    data[5] = LAND_MOUNTAIN;
    let h = 0;
    for (let i = 0; i < data.length; i++) {
      h =
        (h +
          Math.imul(data[i] + 1, Math.imul(i + 1, 0x9e3779b1) ^ 0x85ebca6b)) |
        0;
    }
    expect(new GameMapImpl(4, 4, data, 16).snapshot().pristineHash).toBe(
      h >>> 0,
    );
  });
});

describe("Attack cost on terrain features", () => {
  test("plains without a feature layer: the flat cost", () => {
    const { tiles, lossPerTile } = runAttack(null, true);
    expect(tiles % 8).toBe(0);
    expect(lossPerTile).toBe(FLAT_LOSS);
  });

  test("an all-None layer changes nothing", () => {
    expect(runAttack(TerrainFeature.None, true)).toEqual(runAttack(null, true));
  });

  test("owned forest: attacker losses and capture time x1.2", () => {
    const plain = runAttack(null, true);
    const forest = runAttack(TerrainFeature.Forest, true);
    expect(forest.lossPerTile).toBeCloseTo(FLAT_LOSS * 1.2);
    // 0.125 * 1.2 per tile: 7 tiles a tick instead of 8.
    expect(forest.tiles / plain.tiles).toBe(7 / 8);
  });

  test("unowned forest: capture time x1.2 only", () => {
    const plain = runAttack(null, false);
    const forest = runAttack(TerrainFeature.Forest, false);
    expect(forest.lossPerTile).toBe(FLAT_LOSS);
    expect(forest.tiles / plain.tiles).toBe(7 / 8);
  });

  test("river: capture time x2 and attacker losses x1.25, owned or not", () => {
    for (const defended of [true, false]) {
      const plain = runAttack(null, defended);
      const river = runAttack(TerrainFeature.River, defended);
      expect(river.lossPerTile).toBe(FLAT_LOSS * 1.25);
      // 0.125 * 2 = 0.25 per tile: 4 tiles a tick instead of 8.
      expect(river.tiles / plain.tiles).toBe(4 / 8);
    }
  });

  test("ford: a river tile at normal cost", () => {
    expect(runAttack(TerrainFeature.Ford, true)).toEqual(runAttack(null, true));
    expect(runAttack(TerrainFeature.Ford, false)).toEqual(
      runAttack(null, false),
    );
  });

  test("stacks with the real terrain cost", () => {
    // Against terra nullius a human attacker loses mag / 5 per tile: 16 on
    // plains, whatever the stack.
    const plain = runAttack(null, false, UseRealAttackLogic, 10);
    const river = runAttack(
      TerrainFeature.River,
      false,
      UseRealAttackLogic,
      10,
    );
    const forest = runAttack(
      TerrainFeature.Forest,
      false,
      UseRealAttackLogic,
      10,
    );
    expect(plain.lossPerTile).toBeCloseTo(16);
    expect(river.lossPerTile).toBeCloseTo(16 * 1.25);
    expect(forest.lossPerTile).toBeCloseTo(16);
    expect(forest.tiles).toBeLessThan(plain.tiles);
    expect(river.tiles).toBeLessThan(forest.tiles);
  });
});

describe("Structures on terrain features", () => {
  function ownedGame(feature: (x: number, y: number) => TerrainFeature): {
    game: Game;
    player: Player;
  } {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const w = 40;
    const h = 40;
    const gameMap = new GameMapImpl(
      w,
      h,
      new Uint8Array(w * h).fill(LAND_PLAINS),
      w * h,
      featureLayer(w, h, feature),
    );
    const miniMap = new GameMapImpl(
      w / 2,
      h / 2,
      new Uint8Array((w / 2) * (h / 2)).fill(LAND_PLAINS),
      (w / 2) * (h / 2),
    );
    const game = createGame(
      [new PlayerInfo("builder", PlayerType.Human, "c1", "builder_id")],
      [],
      gameMap,
      miniMap,
      new TestConfig(
        {
          gameMap: GameMapType.Asia,
          gameMapSize: GameMapSize.Normal,
          gameMode: GameMode.FFA,
          gameType: GameType.Singleplayer,
          difficulty: Difficulty.Medium,
          nations: "default",
          donateGold: false,
          donateTroops: false,
          bots: 0,
          infiniteGold: true,
          infiniteTroops: true,
          instantBuild: true,
          randomSpawn: false,
        },
        false,
      ),
    );
    game.endSpawnPhase();
    const player = game.player("builder_id");
    game.forEachTile((t: TileRef) => player.conquer(t));
    return { game, player };
  }

  test("a city clicked on a river is placed on the bank", () => {
    const { game, player } = ownedGame((x) =>
      x === 20
        ? TerrainFeature.River
        : x === 21
          ? TerrainFeature.Ford
          : TerrainFeature.None,
    );
    for (const type of [UnitType.City, UnitType.DefensePost, UnitType.Port]) {
      const spawn = player.canBuild(type, game.ref(20, 20));
      if (type === UnitType.Port) {
        // No shore anywhere on this map.
        expect(spawn).toBe(false);
        continue;
      }
      expect(spawn).not.toBe(false);
      const f = game.terrainFeature(spawn as TileRef);
      expect(f === TerrainFeature.River || f === TerrainFeature.Ford).toBe(
        false,
      );
    }
    // Forest is fine to build on.
    const { game: g2, player: p2 } = ownedGame(() => TerrainFeature.Forest);
    expect(p2.canBuild(UnitType.City, g2.ref(20, 20))).toBe(g2.ref(20, 20));
  });

  test("nothing can be built in the middle of a wide river", () => {
    const { game, player } = ownedGame(() => TerrainFeature.River);
    expect(player.canBuild(UnitType.City, game.ref(20, 20))).toBe(false);
    expect(player.canBuild(UnitType.Factory, game.ref(5, 5))).toBe(false);
  });
});

describe("Nation AI sees terrain features", () => {
  // Impossible nations sample the bot's terrain to size an attack on it, and
  // read forests and rivers the same way they read mountains.
  function botTileLoss(feature: TerrainFeature | null): number {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const w = 60;
    const h = 60;
    const gameMap = new GameMapImpl(
      w,
      h,
      new Uint8Array(w * h).fill(LAND_PLAINS),
      w * h,
      feature === null ? null : featureLayer(w, h, () => feature),
    );
    const miniMap = new GameMapImpl(
      w / 2,
      h / 2,
      new Uint8Array((w / 2) * (h / 2)).fill(LAND_PLAINS),
      (w / 2) * (h / 2),
    );
    const game = createGame(
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
        new PlayerInfo("bot", PlayerType.Bot, null, "bot"),
      ],
      [],
      gameMap,
      miniMap,
      new UseRealAttackLogic(
        {
          gameMap: GameMapType.Asia,
          gameMapSize: GameMapSize.Normal,
          gameMode: GameMode.FFA,
          gameType: GameType.Singleplayer,
          difficulty: Difficulty.Impossible,
          nations: "default",
          donateGold: false,
          donateTroops: false,
          bots: 0,
          infiniteGold: false,
          infiniteTroops: false,
          instantBuild: false,
          randomSpawn: false,
        },
        false,
      ),
    );
    game.endSpawnPhase();
    const nation = game.player("nation");
    const bot = game.player("bot");
    game.forEachTile((t) => (game.x(t) < 20 ? nation : bot).conquer(t));
    nation.setTroops(500_000);
    bot.setTroops(20_000);
    bot.largestClusterBoundingBox = {
      min: new Cell(20, 0),
      max: new Cell(w - 1, h - 1),
    };
    const behavior = new NationAttackBehavior(
      new PseudoRandom(42),
      game,
      nation,
      0,
      0,
      0,
      { maybeBetray: vi.fn() } as any,
      { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as any,
      {} as any,
    );
    return behavior["botTileLoss"](bot, 40_000);
  }

  test("forest and river raise the expected loss, fords don't", () => {
    const plain = botTileLoss(null);
    expect(plain).toBeGreaterThan(0);
    expect(botTileLoss(TerrainFeature.Forest)).toBeCloseTo(plain * 1.2);
    expect(botTileLoss(TerrainFeature.River)).toBeCloseTo(plain * 1.25);
    expect(botTileLoss(TerrainFeature.Ford)).toBeCloseTo(plain);
  });
});
