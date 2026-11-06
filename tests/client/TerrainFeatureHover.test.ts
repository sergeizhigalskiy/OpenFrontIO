import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import fs from "fs";
import path from "path";
import { describe, expect, test, vi } from "vitest";
import { terrainFeatureHoverText } from "../../src/client/hud/layers/TerrainFeatureHover";

vi.mock("../../src/client/Utils", () => ({
  translateText: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../resources/lang/en.json"), "utf8"),
) as { terrain_feature: Record<string, string> };

describe("terrain feature hover text", () => {
  test("shows each feature's effect from the rule constants", () => {
    expect(terrainFeatureHoverText(TerrainFeature.None, true)).toBeNull();
    expect(terrainFeatureHoverText(TerrainFeature.Forest, true)).toBe(
      'terrain_feature.forest_owned {"percent":20}',
    );
    expect(terrainFeatureHoverText(TerrainFeature.Forest, false)).toBe(
      'terrain_feature.forest_unowned {"percent":20}',
    );
    expect(terrainFeatureHoverText(TerrainFeature.River, true)).toBe(
      'terrain_feature.river {"time":100,"loss":25}',
    );
    expect(terrainFeatureHoverText(TerrainFeature.Ford, false)).toBe(
      "terrain_feature.ford",
    );
  });

  test("every key has an English string", () => {
    expect(en.terrain_feature.forest_owned).toBe(
      "Forest: defenders +{percent}%",
    );
    for (const key of ["forest_unowned", "river", "ford"]) {
      expect(en.terrain_feature[key]).toBeTruthy();
    }
  });
});
