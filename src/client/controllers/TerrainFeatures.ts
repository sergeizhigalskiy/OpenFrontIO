import { unpackTerrainFeatures } from "@openfront/engine-lib/game/TerrainFeatures";
import { TerrainMapData } from "@openfront/engine-lib/game/TerrainMapLoader";
import { MapRenderer } from "../render/gl";

/**
 * Hands the renderer the map's forests, rivers and fords. Maps without a
 * feature layer draw nothing extra.
 */
export function pushTerrainFeatures(
  view: MapRenderer,
  terrain: TerrainMapData,
): void {
  if (terrain.terrainFeatures === undefined) return;
  const map = terrain.gameMap;
  view.setTerrainFeatures(
    unpackTerrainFeatures(terrain.terrainFeatures, map.width() * map.height()),
  );
}
