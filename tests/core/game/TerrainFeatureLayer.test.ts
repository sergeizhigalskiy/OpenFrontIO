import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import { MapFiles, MapManifest } from "@openfront/engine-api/game/MapFiles";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { packTerrainFeatures } from "@openfront/engine-lib/game/TerrainFeatures";
import { loadTerrainMap } from "@openfront/engine-lib/game/TerrainMapLoader";
import { FetchGameMapLoader } from "@openfront/shared/FetchGameMapLoader";
import {
  GameMapLoader,
  loadMapFiles,
  mapFilesTransfer,
  MapData,
} from "@openfront/shared/GameMapLoader";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, test, vi } from "vitest";
import { NodeGameMapLoader } from "../../perf/fullgame/NodeGameMapLoader";

const LAND = 0b10000000;

/** An 8x8 map (4x4 and 2x2 minimaps), all plains. */
function manifest(features: boolean): MapManifest {
  return {
    id: "Test",
    name: "Test",
    translation_key: "map.test",
    categories: ["fictional"],
    nations: [],
    map: { width: 8, height: 8, num_land_tiles: 64 },
    map4x: { width: 4, height: 4, num_land_tiles: 16 },
    map16x: { width: 2, height: 2, num_land_tiles: 4 },
    ...(features ? { features: { version: 1 as const } } : {}),
  };
}

/** Column x carries feature x % 4 (none, forest, river, ford). */
function layer(width: number, height: number): Uint8Array {
  const out: TerrainFeature[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.push(x % 4);
  }
  return packTerrainFeatures(out);
}

function files(mapSize: GameMapSize, features: boolean): MapFiles {
  return {
    map: GameMapType.Onion,
    mapSize,
    manifest: manifest(features),
    mapBin: new Uint8Array(64).fill(LAND),
    map4xBin: new Uint8Array(16).fill(LAND),
    map16xBin: new Uint8Array(4).fill(LAND),
    featuresBin: features ? layer(8, 8) : undefined,
    features4xBin: features ? layer(4, 4) : undefined,
  };
}

const maps = new NodeGameMapLoader(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../resources/maps",
  ),
);

describe("Terrain feature layer loading", () => {
  test("a map without the layer loads as before: no features", async () => {
    for (const size of [GameMapSize.Normal, GameMapSize.Compact]) {
      const { gameMap, miniGameMap } = await loadTerrainMap(files(size, false));
      gameMap.forEachTile((t) =>
        expect(gameMap.terrainFeature(t)).toBe(TerrainFeature.None),
      );
      miniGameMap.forEachTile((t) =>
        expect(miniGameMap.terrainFeature(t)).toBe(TerrainFeature.None),
      );
    }
  });

  test("normal games read features.bin, compact ones features4x.bin", async () => {
    const normal = await loadTerrainMap(files(GameMapSize.Normal, true));
    expect(normal.gameMap.width()).toBe(8);
    const compact = await loadTerrainMap(files(GameMapSize.Compact, true));
    expect(compact.gameMap.width()).toBe(4);
    for (const { gameMap } of [normal, compact]) {
      for (let x = 0; x < gameMap.width(); x++) {
        expect(gameMap.terrainFeature(gameMap.ref(x, 1))).toBe(x % 4);
      }
    }
    // The minimap (pathfinding) has no features.
    expect(
      normal.miniGameMap.terrainFeature(normal.miniGameMap.ref(2, 0)),
    ).toBe(TerrainFeature.None);
  });

  test("a layer the manifest lists but wasn't passed fails", async () => {
    await expect(
      loadTerrainMap({
        ...files(GameMapSize.Normal, true),
        featuresBin: undefined,
      }),
    ).rejects.toThrow(/features\.bin of .* was not passed/);
    await expect(
      loadTerrainMap({
        ...files(GameMapSize.Compact, true),
        features4xBin: undefined,
      }),
    ).rejects.toThrow(/features4x\.bin of .* was not passed/);
  });

  test("an unknown layer version fails", async () => {
    const f = files(GameMapSize.Normal, true);
    (f.manifest.features as { version: number }).version = 2;
    await expect(loadTerrainMap(f)).rejects.toThrow(/feature layer version/);
  });

  test("loadMapFiles fetches the layer only when the manifest lists it", async () => {
    const loader = (features: boolean) => {
      const featuresBin = vi.fn(async () => layer(8, 8));
      const features4xBin = vi.fn(async () => layer(4, 4));
      const data: MapData = {
        mapBin: async () => new Uint8Array(64).fill(LAND),
        map4xBin: async () => new Uint8Array(16).fill(LAND),
        map16xBin: async () => new Uint8Array(4).fill(LAND),
        featuresBin,
        features4xBin,
        manifest: async () => manifest(features),
        webpPath: "",
        layerImage: async () => {
          throw new Error("no layers");
        },
      };
      const l: GameMapLoader = { getMapData: () => data };
      return { l, featuresBin, features4xBin };
    };

    const plain = loader(false);
    const plainFiles = await loadMapFiles(
      plain.l,
      GameMapType.Onion,
      GameMapSize.Normal,
    );
    expect(plainFiles.featuresBin).toBeUndefined();
    expect(plain.featuresBin).not.toHaveBeenCalled();
    expect(plain.features4xBin).not.toHaveBeenCalled();

    const featured = loader(true);
    const normal = await loadMapFiles(
      featured.l,
      GameMapType.Onion,
      GameMapSize.Normal,
    );
    expect(normal.featuresBin).toBeInstanceOf(Uint8Array);
    expect(normal.features4xBin).toBeUndefined();
    expect(mapFilesTransfer(normal)).toEqual([
      normal.mapBin!.buffer,
      normal.map4xBin!.buffer,
      normal.featuresBin!.buffer,
    ]);
    const compact = await loadMapFiles(
      featured.l,
      GameMapType.Onion,
      GameMapSize.Compact,
    );
    expect(compact.featuresBin).toBeUndefined();
    expect(compact.features4xBin).toBeInstanceOf(Uint8Array);
    expect(featured.featuresBin).toHaveBeenCalledTimes(1);
    expect(featured.features4xBin).toHaveBeenCalledTimes(1);
  });

  test("FetchGameMapLoader fetches the layer next to the map files", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
      statusText: "OK",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const data = new FetchGameMapLoader("/maps").getMapData(GameMapType.China);
    await data.featuresBin();
    expect(fetchMock).toHaveBeenLastCalledWith("/maps/china/features.bin");
    await data.features4xBin();
    expect(fetchMock).toHaveBeenLastCalledWith("/maps/china/features4x.bin");
    vi.unstubAllGlobals();
  });

  test("an existing map without the layer still loads from its files", async () => {
    const mapFiles = await loadMapFiles(
      maps,
      GameMapType.Onion,
      GameMapSize.Normal,
    );
    expect(mapFiles.manifest.features).toBeUndefined();
    expect(mapFiles.featuresBin).toBeUndefined();
    const { gameMap } = await loadTerrainMap(mapFiles);
    expect(gameMap.terrainFeature(gameMap.ref(10, 10))).toBe(
      TerrainFeature.None,
    );
  });

  test.each([
    GameMapType.Hourglass,
    GameMapType.SevenPasses,
    GameMapType.Caldera,
    GameMapType.DrowningDelta,
    GameMapType.ShatteredCrown,
  ])(
    "%s ships a feature layer the game reads",
    async (type) => {
      for (const size of [GameMapSize.Normal, GameMapSize.Compact]) {
        const mapFiles = await loadMapFiles(maps, type, size);
        expect(mapFiles.manifest.features).toEqual({ version: 1 });
        const { gameMap, nations } = await loadTerrainMap(mapFiles);
        const counts = [0, 0, 0, 0];
        let offLand = 0;
        const numTiles = gameMap.width() * gameMap.height();
        for (let t = 0; t < numTiles; t++) {
          const f = gameMap.terrainFeature(t);
          counts[f]++;
          // Features only sit on passable land.
          if (
            f !== TerrainFeature.None &&
            (!gameMap.isLand(t) || gameMap.isImpassable(t))
          ) {
            offLand++;
          }
        }
        expect(offLand).toBe(0);
        expect(counts[TerrainFeature.Forest]).toBeGreaterThan(0);
        if (type !== GameMapType.ShatteredCrown) {
          expect(counts[TerrainFeature.River]).toBeGreaterThan(0);
          expect(counts[TerrainFeature.Ford]).toBeGreaterThan(0);
        }
        // Every nation spawns on dry land, off rivers and fords.
        for (const nation of nations) {
          const [x, y] = nation.coordinates!;
          const tile = gameMap.ref(x, y);
          expect(gameMap.isLand(tile) && !gameMap.isImpassable(tile)).toBe(
            true,
          );
          expect([TerrainFeature.None, TerrainFeature.Forest]).toContain(
            gameMap.terrainFeature(tile),
          );
        }
      }
    },
    30_000,
  );
});
