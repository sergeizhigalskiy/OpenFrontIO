import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import {
  FOREST_DEFENDED_LOSS_MULTIPLIER,
  FOREST_TIME_MULTIPLIER,
  RIVER_LOSS_MULTIPLIER,
  RIVER_TIME_MULTIPLIER,
} from "@openfront/engine-lib/game/TerrainFeatures";
import { html, TemplateResult } from "lit";
import { translateText } from "../../Utils";

const percent = (multiplier: number) => Math.round((multiplier - 1) * 100);

/**
 * What a hovered tile's terrain feature does to an attack on it, e.g.
 * "Forest: defenders +30%". `owned` is true when a player holds the tile.
 */
export function terrainFeatureHoverText(
  feature: TerrainFeature,
  owned: boolean,
): string | null {
  switch (feature) {
    case TerrainFeature.None:
      return null;
    case TerrainFeature.Forest:
      return owned
        ? translateText("terrain_feature.forest_owned", {
            percent: percent(FOREST_DEFENDED_LOSS_MULTIPLIER),
          })
        : translateText("terrain_feature.forest_unowned", {
            percent: percent(FOREST_TIME_MULTIPLIER),
          });
    case TerrainFeature.River:
      return translateText("terrain_feature.river", {
        time: percent(RIVER_TIME_MULTIPLIER),
        loss: percent(RIVER_LOSS_MULTIPLIER),
      });
    case TerrainFeature.Ford:
      return translateText("terrain_feature.ford");
  }
}

/** The hover card's terrain feature line, or nothing. */
export function renderTerrainFeatureLine(
  feature: TerrainFeature,
  owned: boolean,
): TemplateResult | string {
  const text = terrainFeatureHoverText(feature, owned);
  if (text === null) return "";
  return html`<div
    class="px-2 py-1 text-sm text-emerald-200"
    data-testid="terrain-feature"
  >
    ${text}
  </div>`;
}
