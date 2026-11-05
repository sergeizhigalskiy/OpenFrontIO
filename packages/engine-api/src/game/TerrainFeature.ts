/**
 * Per-tile terrain feature, read from a map's optional feature layer
 * (features.bin / features4x.bin, written by the map generator from
 * features.png). Maps without the layer have no features anywhere.
 *
 * The values are the 2-bit codes stored in the file, so they must not change.
 * The rules for each feature live in engine-lib/game/TerrainFeatures.ts.
 */
export enum TerrainFeature {
  None = 0,
  Forest = 1,
  /** A land tile crossed by a river. */
  River = 2,
  /** A river tile that crosses at normal cost. */
  Ford = 3,
}
