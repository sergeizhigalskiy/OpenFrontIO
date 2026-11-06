import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { defensePostRange } from "@openfront/engine-lib/game/Siege";
import { EventBus } from "@openfront/shared/EventBus";
import { describe, expect, test } from "vitest";
import { BuildPreviewController } from "../../../src/client/controllers/BuildPreviewController";

/** A controller holding a ghost of `type`, upgrading a post of `level` if set. */
function ghostFor(type: UnitType, upgradeLevel: number | null) {
  const width = 100;
  const post = { tile: () => 4242, level: () => upgradeLevel ?? 1 };
  const game = {
    isImpassable: () => false,
    isValidCoord: () => true,
    ref: (x: number, y: number) => y * width + x,
    myPlayer: () => ({
      gold: () => 10_000_000n,
      smallID: () => 1,
      isAlive: () => true,
    }),
    unit: (id: number) => (id === 7 ? post : undefined),
    config: () => ({ defensePostRange: defensePostRange }),
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
      canBuild: upgradeLevel === null ? 4343 : false,
      canUpgrade: upgradeLevel === null ? false : 7,
      cost: 100_000n,
      upgradeCosts: upgradeLevel === null ? undefined : [100_000n],
      overlappingRailroads: [],
      ghostRailPaths: [],
    },
  };
  (controller as any).ghostResolved = true;
  (controller as any).resolvedGhostTile = 4343;
  return (controller as any).buildGhostPreviewData(4343, false);
}

describe("defense line build previews", () => {
  test("a new defense post shows level 1's range", () => {
    expect(ghostFor(UnitType.DefensePost, null).rangeRadius).toBe(30);
  });

  test("a defense post upgrade shows the range it grows to, around the post", () => {
    const toTwo = ghostFor(UnitType.DefensePost, 1);
    expect(toTwo.rangeRadius).toBe(38);
    expect(toTwo.radiusTileX).toBe(42);
    expect(toTwo.radiusTileY).toBe(42);
    expect(ghostFor(UnitType.DefensePost, 2).rangeRadius).toBe(45);
  });
});
