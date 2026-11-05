import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import { MapFiles, MapManifest } from "@openfront/engine-api/game/MapFiles";

/** Where a host gets a map's files, its thumbnail and its layer images. */
export interface GameMapLoader {
  getMapData(map: GameMapType): MapData;
}

export interface MapData {
  mapBin: () => Promise<Uint8Array>;
  map4xBin: () => Promise<Uint8Array>;
  map16xBin: () => Promise<Uint8Array>;
  /** features.bin / features4x.bin; only maps whose manifest lists `features` have them. */
  featuresBin: () => Promise<Uint8Array>;
  features4xBin: () => Promise<Uint8Array>;
  manifest: () => Promise<MapManifest>;
  webpPath: string;
  /**
   * Load a map layer image by layer id. `compact` selects the map4x-sized
   * variant (`<id>.4x.webp`; ids cannot contain dots, so it never collides
   * with another layer), which Compact games draw on directly.
   */
  layerImage: (layerId: string, compact: boolean) => Promise<ImageBitmap>;
}

/** Loads the files a game on this map and size reads (see MapFiles). */
export async function loadMapFiles(
  loader: GameMapLoader,
  map: GameMapType,
  mapSize: GameMapSize,
): Promise<MapFiles> {
  const data = loader.getMapData(map);
  const manifestLoad = data.manifest();
  // The feature layer is fetched alongside the bins once the manifest says
  // the map has one.
  const features = (bin: () => Promise<Uint8Array>) =>
    manifestLoad.then((m) => (m.features === undefined ? undefined : bin()));
  if (mapSize === GameMapSize.Normal) {
    const [manifest, mapBin, map4xBin, featuresBin] = await Promise.all([
      manifestLoad,
      data.mapBin(),
      data.map4xBin(),
      features(() => data.featuresBin()),
    ]);
    return { map, mapSize, manifest, mapBin, map4xBin, featuresBin };
  }
  const [manifest, map4xBin, map16xBin, features4xBin] = await Promise.all([
    manifestLoad,
    data.map4xBin(),
    data.map16xBin(),
    features(() => data.features4xBin()),
  ]);
  return { map, mapSize, manifest, map4xBin, map16xBin, features4xBin };
}

/** The files' buffers, to move them to a worker instead of copying them. */
export function mapFilesTransfer(files: MapFiles): ArrayBuffer[] {
  return [
    files.mapBin,
    files.map4xBin,
    files.map16xBin,
    files.featuresBin,
    files.features4xBin,
  ].flatMap((bin) => (bin === undefined ? [] : [bin.buffer as ArrayBuffer]));
}
