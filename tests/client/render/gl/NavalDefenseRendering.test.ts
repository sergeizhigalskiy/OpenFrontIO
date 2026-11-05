import { describe, expect, it } from "vitest";
import { BarPass } from "../../../../src/client/render/gl/passes/BarPass";
import { visibleMinefields } from "../../../../src/client/render/gl/passes/MinefieldPass";
import type { UnitState } from "../../../../src/client/render/types";

const MAP_W = 100;

function unit(over: Partial<UnitState>): UnitState {
  return {
    id: 1,
    unitType: "Minefield",
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
    health: 50,
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

describe("minefield visibility", () => {
  // Player 1 is local, 2 an ally, 3 an enemy.
  const units = [
    unit({ id: 1, ownerID: 1, pos: 5 * MAP_W + 7, health: 100 }),
    unit({ id: 2, ownerID: 2, pos: 10, health: 20 }),
    unit({ id: 3, ownerID: 3, pos: 20 }),
    unit({ id: 4, ownerID: 1, pos: 30, isActive: false }),
    unit({ id: 5, ownerID: 1, unitType: "Warship", health: 1000 }),
  ];

  it("shows the local player's and friends' fields, faded by density", () => {
    expect(visibleMinefields(units, 1, new Set([2]), MAP_W)).toEqual([
      { x: 7, y: 5, density: 1, own: true },
      { x: 10, y: 0, density: 0.2, own: false },
    ]);
  });

  it("never shows an enemy's field", () => {
    const seenByEnemy = visibleMinefields(units, 3, new Set(), MAP_W);
    expect(seenByEnemy.map((f) => f.own)).toEqual([true]);
    expect(visibleMinefields(units, 4, new Set(), MAP_W)).toEqual([]);
  });

  it("shows nothing without a local player (spectators, replays)", () => {
    expect(visibleMinefields(units, 0, new Set([1, 2, 3]), MAP_W)).toEqual([]);
  });
});

describe("health bars", () => {
  function barPass(): BarPass {
    const pass = Object.create(BarPass.prototype) as BarPass;
    Object.assign(pass, {
      maxBars: 64,
      mapW: MAP_W,
      healthData: new Float32Array(64 * 3),
      progressData: new Float32Array(64 * 3),
      veterancyData: new Float32Array(64 * 3),
      warshipMaxHealth: 1000,
      veterancyHealthBonus: 0,
      maxHealthByType: new Map(),
      config: {
        unitInfo: (type: string) => ({
          maxHealth:
            type === "Coastal Battery"
              ? 1500
              : type === "Minefield"
                ? 100
                : undefined,
        }),
      },
    });
    return pass;
  }

  it("draws a damaged battery's bar against its own max health", () => {
    const pass = barPass();
    const units = new Map([
      [1, unit({ id: 1, unitType: "Coastal Battery", health: 1200, pos: 3 })],
      [2, unit({ id: 2, unitType: "Coastal Battery", health: 1500, pos: 4 })],
    ]);
    pass.updateBars(units, new Map(), 0);
    const p = pass as unknown as {
      healthCount: number;
      healthData: Float32Array;
    };
    expect(p.healthCount).toBe(1);
    expect(p.healthData[0]).toBe(3);
    expect(p.healthData[2]).toBeCloseTo(0.8);
  });

  it("never draws a bar for a minefield, which would show it to everyone", () => {
    const pass = barPass();
    const units = new Map([
      [1, unit({ id: 1, unitType: "Minefield", health: 40 })],
    ]);
    pass.updateBars(units, new Map(), 0);
    expect((pass as unknown as { healthCount: number }).healthCount).toBe(0);
  });
});
