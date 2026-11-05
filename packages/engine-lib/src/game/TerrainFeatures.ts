/**
 * Terrain feature rules: forests favor defenders, and rivers are slow to
 * cross except at fords.
 *
 * Shared by the engine (attack cost, structure placement, nation AI) and the
 * client (tile hover, feature rendering), so every tunable number lives here.
 * The multipliers stack on top of the terrain cost (plains, highland,
 * mountain), defense posts and everything else attackLogic applies.
 *
 * The feature layer is static map data: map files carry it, so it is never
 * part of a snapshot.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";

export { TerrainFeature };

// ---------------------------------------------------------------------------
// Attack cost
// ---------------------------------------------------------------------------

/** Attacker troop loss on a forest tile a player owns. */
export const FOREST_DEFENDED_LOSS_MULTIPLIER = 1.3;
/** Capture time on a forest tile, owned or not. */
export const FOREST_TIME_MULTIPLIER = 1.3;
/** Attacker troop loss on a river tile, owned or not. */
export const RIVER_LOSS_MULTIPLIER = 1.5;
/** Capture time on a river tile, owned or not. */
export const RIVER_TIME_MULTIPLIER = 2.5;
// A ford is a river tile captured at normal cost: no multiplier.

// Indexed by TerrainFeature. The attack loop reads these for every tile it
// captures, so a table read is all a lookup costs.
const LOSS_DEFENDED = Float64Array.of(
  1,
  FOREST_DEFENDED_LOSS_MULTIPLIER,
  RIVER_LOSS_MULTIPLIER,
  1,
);
const LOSS_UNOWNED = Float64Array.of(1, 1, RIVER_LOSS_MULTIPLIER, 1);
const TIME = Float64Array.of(
  1,
  FOREST_TIME_MULTIPLIER,
  RIVER_TIME_MULTIPLIER,
  1,
);

/**
 * Attacker troop loss multiplier for capturing a tile with this feature.
 * `defendedByPlayer` is true when a player owns the tile (false for
 * terra nullius): unowned forest costs time only.
 */
export function terrainFeatureLossMultiplier(
  feature: TerrainFeature,
  defendedByPlayer: boolean,
): number {
  return (defendedByPlayer ? LOSS_DEFENDED : LOSS_UNOWNED)[feature];
}

/** Capture time multiplier for a tile with this feature. */
export function terrainFeatureTimeMultiplier(feature: TerrainFeature): number {
  return TIME[feature];
}

/** The two parts of attackLogic's result a terrain feature scales. */
export interface TerrainFeatureCost {
  attackerTroopLoss: number;
  /** Share of the tick's conquest budget the tile consumes (capture time). */
  tickFraction: number;
}

/**
 * Scales a tile's attack cost by its terrain feature, in place, and returns
 * it. AttackExecution wraps attackLogic's result with this.
 */
export function withTerrainFeatureCost<T extends TerrainFeatureCost>(
  cost: T,
  feature: TerrainFeature,
  defendedByPlayer: boolean,
): T {
  if (feature !== TerrainFeature.None) {
    cost.attackerTroopLoss *= terrainFeatureLossMultiplier(
      feature,
      defendedByPlayer,
    );
    cost.tickFraction *= TIME[feature];
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Structures
// ---------------------------------------------------------------------------

/** No structure can be built on a river or ford tile. */
export function terrainFeatureAllowsStructures(
  feature: TerrainFeature,
): boolean {
  return feature !== TerrainFeature.River && feature !== TerrainFeature.Ford;
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

/**
 * features.bin / features4x.bin: one 2-bit TerrainFeature per tile in tile
 * order (row-major, ref = y * width + x), four tiles per byte, the lowest
 * bits first: tile `ref` is `(bytes[ref >> 2] >> ((ref & 3) * 2)) & 3`.
 * The map generator (map-generator/features.go) writes the same layout.
 */
export const TERRAIN_FEATURES_VERSION = 1;

/** Byte length of a feature layer for a map of `numTiles` tiles. */
export function terrainFeaturesByteLength(numTiles: number): number {
  return (numTiles + 3) >> 2;
}

/** The feature of tile `ref` in a packed feature layer. */
export function terrainFeatureAt(
  packed: Uint8Array,
  ref: TileRef,
): TerrainFeature {
  return (packed[ref >> 2] >> ((ref & 3) << 1)) & 3;
}

/** Packs one TerrainFeature per tile into the file layout. */
export function packTerrainFeatures(
  features: ArrayLike<TerrainFeature>,
): Uint8Array {
  const packed = new Uint8Array(terrainFeaturesByteLength(features.length));
  for (let ref = 0; ref < features.length; ref++) {
    packed[ref >> 2] |= (features[ref] & 3) << ((ref & 3) << 1);
  }
  return packed;
}

/** One TerrainFeature byte per tile, e.g. for a texture upload. */
export function unpackTerrainFeatures(
  packed: Uint8Array,
  numTiles: number,
): Uint8Array {
  const out = new Uint8Array(numTiles);
  for (let ref = 0; ref < numTiles; ref++) {
    out[ref] = terrainFeatureAt(packed, ref);
  }
  return out;
}
