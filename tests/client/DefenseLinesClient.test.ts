/**
 * Client side of defense posts: the coverage overlay stamps every built
 * post, all at the engine's one range.
 */
import { describe, expect, it } from "vitest";
import { defensePostCircles } from "../../src/client/render/gl/passes/DefenseCoveragePass";
import { type UnitState } from "../../src/client/render/types";

function unit(over: Partial<UnitState>): UnitState {
  return {
    id: 1,
    unitType: "Defense Post",
    ownerID: 1,
    lastOwnerID: null,
    pos: 0,
    lastPos: 0,
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    waitTicks: 0,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level: 1,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    samUpgradeStartTick: null,
    samUpgradeStartRange: null,
    samUpgradeTargetLevel: null,
    samUpgradeDuration: null,
    ...over,
  };
}

describe("defense coverage overlay", () => {
  it("stamps every built post, whatever its level", () => {
    const w = 100;
    const circles = defensePostCircles(
      [
        unit({ id: 1, pos: 5 * w + 7, level: 1 }),
        unit({ id: 2, pos: 10, level: 2, ownerID: 3 }),
        unit({ id: 3, pos: 20, level: 3 }),
        unit({ id: 4, pos: 30, underConstruction: true }),
        unit({ id: 5, pos: 40, unitType: "City" }),
      ],
      w,
    );
    expect(circles).toEqual([
      { x: 7, y: 5, ownerID: 1 },
      { x: 10, y: 0, ownerID: 3 },
      { x: 20, y: 0, ownerID: 1 },
    ]);
  });
});
