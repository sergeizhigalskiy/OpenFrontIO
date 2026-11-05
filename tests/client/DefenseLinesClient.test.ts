/**
 * Client side of defense lines: the coverage overlay stamps each defense
 * post with its own level's range, and the siege camp is in the build menu
 * with its strings and an existing icon.
 */
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import en from "../../resources/lang/en.json";
import { flattenedBuildTable } from "../../src/client/hud/layers/BuildMenu";
import { defensePostCircles } from "../../src/client/render/gl/passes/DefenseCoveragePass";
import {
  ALL_UNIT_TYPES,
  STRUCTURE_TYPES,
  UT_SIEGE_CAMP,
  type UnitState,
} from "../../src/client/render/types";

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
  it("gives each built post the range of its level", () => {
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
      { x: 7, y: 5, ownerID: 1, range: 30 },
      { x: 10, y: 0, ownerID: 3, range: 38 },
      { x: 20, y: 0, ownerID: 1, range: 45 },
    ]);
  });
});

describe("siege camp in the client", () => {
  it("has a build menu entry with an existing icon, a name and a description", () => {
    const entry = flattenedBuildTable.find(
      (e) => e.unitType === UnitType.SiegeCamp,
    );
    expect(entry).toBeDefined();
    // Its own catapult glyph (scripts/genUnitArt.ts).
    expect(entry!.icon).toContain("SiegeCampIconWhite.svg");
    expect(entry!.key).toBe("unit_type.siege_camp");
    expect(entry!.description).toBe("build_menu.desc.siege_camp");
    expect(en.unit_type.siege_camp).toBe("Siege Camp");
    expect(en.build_menu.desc.siege_camp.length).toBeGreaterThan(0);
  });

  it("is drawn as a structure", () => {
    expect(UT_SIEGE_CAMP).toBe(UnitType.SiegeCamp);
    expect(STRUCTURE_TYPES.has(UT_SIEGE_CAMP)).toBe(true);
    expect(ALL_UNIT_TYPES).toContain(UT_SIEGE_CAMP);
  });

  it("has the attack forecast's strings", () => {
    expect(Object.keys(en.attack_forecast).sort()).toEqual([
      "defense_post",
      "defense_post_reduced",
      "loss",
      "speed",
    ]);
  });
});
