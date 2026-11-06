import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { DEFENSE_POST_RANGE } from "@openfront/engine-lib/game/DefensePosts";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, test } from "vitest";
import { BuildPreviewController } from "../../../src/client/controllers/BuildPreviewController";

/** A controller holding a ghost of `type`. */
function ghostFor(type: UnitType) {
  const width = 100;
  const game = {
    isImpassable: () => false,
    isValidCoord: () => true,
    ref: (x: number, y: number) => y * width + x,
    myPlayer: () => ({
      gold: () => 10_000_000n,
      smallID: () => 1,
      isAlive: () => true,
    }),
    unit: () => undefined,
    config: () => ({ defensePostRange: () => DEFENSE_POST_RANGE }),
    x: (t: number) => t % width,
    y: (t: number) => Math.floor(t / width),
  };
  const controller = new BuildPreviewController(
    game as any,
    new EventBus(),
    { ghostStructure: type, upgradeMultiplier: 1 } as any,
    { screenToWorldCoordinates: () => ({ x: 3, y: 4 }) } as any,
    { updateGhostPreview: () => {}, updateNukeTrajectory: () => {} } as any,
    {
      nukeAllianceSafetyDuration: () => 0,
      cursorCostLabel: () => true,
      snapBuildPreview: () => false,
    } as any,
  );
  (controller as any).ghostUnit = {
    buildableUnit: {
      type,
      canBuild: 4343,
      canUpgrade: false,
      cost: 100_000n,
      upgradeCosts: undefined,
      overlappingRailroads: [],
      ghostRailPaths: [],
    },
  };
  (controller as any).ghostResolved = true;
  (controller as any).resolvedGhostTile = 4343;
  return (controller as any).buildGhostPreviewData(4343, false);
}

describe("defense post build preview", () => {
  test("a new defense post shows the 30-tile range", () => {
    expect(ghostFor(UnitType.DefensePost).rangeRadius).toBe(30);
  });
});
