/**
 * Reload bars: which units get one, how many pips and how full each is. All
 * from a unit's missile timer queue (the tick each round was fired) and the
 * current tick.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RELOAD_PIPS,
  reloadBar,
  reloadPips,
  reloadSpec,
  reloadState,
} from "../../../../../src/client/render/frame/derive/ReloadBars";
import {
  reloadBarHalfIcon,
  writeReloadBarInstances,
} from "../../../../../src/client/render/gl/passes/ReloadBarPass";
import type { UnitState } from "../../../../../src/client/render/types";
import {
  UT_CITY,
  UT_MISSILE_SILO,
  UT_SAM_LAUNCHER,
  UT_WARSHIP,
} from "../../../../../src/client/render/types";

const SAM_COOLDOWN = 90;
const SILO_COOLDOWN = 75;
const config = {
  SAMCooldown: () => SAM_COOLDOWN,
  SiloCooldown: () => SILO_COOLDOWN,
};

function unit(over: Partial<UnitState>): UnitState {
  return {
    id: 1,
    unitType: UT_SAM_LAUNCHER,
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

describe("reloadSpec", () => {
  it("gives SAMs and silos a round per level on their config cooldown", () => {
    expect(reloadSpec(UT_SAM_LAUNCHER, 3, config)).toEqual({
      rounds: 3,
      reloadTicks: SAM_COOLDOWN,
    });
    expect(reloadSpec(UT_MISSILE_SILO, 2, config)).toEqual({
      rounds: 2,
      reloadTicks: SILO_COOLDOWN,
    });
  });

  it("is null for units that don't reload", () => {
    expect(reloadSpec(UT_CITY, 3, config)).toBeNull();
    expect(reloadSpec(UT_WARSHIP, 1, config)).toBeNull();
  });
});

describe("reloadState", () => {
  const sam3 = { rounds: 3, reloadTicks: 90 };

  it("has every round ready with an empty queue", () => {
    expect(reloadState([], sam3, 500)).toEqual({
      rounds: 3,
      ready: 3,
      reloading: [],
      nextReadyTicks: 0,
    });
  });

  it("fills each reloading round by its own timer, fullest first", () => {
    const s = reloadState([45, 0], sam3, 60);
    expect(s.rounds).toBe(3);
    expect(s.ready).toBe(1);
    expect(s.reloading).toHaveLength(2);
    expect(s.reloading[0]).toBeCloseTo(60 / 90);
    expect(s.reloading[1]).toBeCloseTo(15 / 90);
    // The oldest timer (tick 0) loads at tick 90.
    expect(s.nextReadyTicks).toBe(30);
  });

  it("works for two rounds fired apart", () => {
    const two = { rounds: 2, reloadTicks: 30 };
    const one = reloadState([100], two, 115);
    expect(one.ready).toBe(1);
    expect(one.reloading).toEqual([0.5]);
    expect(one.nextReadyTicks).toBe(15);
    const both = reloadState([100, 110], two, 115);
    expect(both.ready).toBe(0);
    expect(both.reloading).toEqual([0.5, 5 / 30]);
  });

  it("clamps fills to 0-1 and never counts more rounds than it holds", () => {
    const s = reloadState([0, 200, 300], { rounds: 2, reloadTicks: 50 }, 100);
    expect(s.ready).toBe(0);
    expect(s.reloading).toEqual([1, 0]);
    expect(s.nextReadyTicks).toBe(0);
  });
});

describe("reloadPips", () => {
  it("draws ready rounds full, then the reloading ones", () => {
    const pips = reloadPips(
      reloadState([45, 0], { rounds: 3, reloadTicks: 90 }, 60),
    );
    expect(pips.map((p) => p.ready)).toEqual([true, false, false]);
    expect(pips[0].fill).toBe(1);
    expect(pips[1].fill).toBeCloseTo(60 / 90);
    expect(pips[2].fill).toBeCloseTo(15 / 90);
  });

  it("gives a one-round unit one bar that fills", () => {
    const pips = reloadPips(
      reloadState([10], { rounds: 1, reloadTicks: 30 }, 25),
    );
    expect(pips).toEqual([{ fill: 0.5, ready: false }]);
  });

  it("folds a unit with many rounds into one bar", () => {
    const rounds = MAX_RELOAD_PIPS + 2;
    const s = reloadState([0, 0], { rounds, reloadTicks: 100 }, 50);
    // Eight ready plus two half-loaded rounds, of ten.
    expect(reloadPips(s)).toEqual([{ fill: 9 / 10, ready: false }]);
  });
});

describe("reloadBar", () => {
  it("is hidden while every round is ready", () => {
    expect(reloadBar(unit({ level: 2 }), 100, config)).toBeNull();
  });

  it("is hidden for units that are gone, being built or don't reload", () => {
    const queue = { missileTimerQueue: [90] };
    expect(
      reloadBar(unit({ ...queue, isActive: false }), 100, config),
    ).toBeNull();
    expect(
      reloadBar(unit({ ...queue, underConstruction: true }), 100, config),
    ).toBeNull();
    expect(
      reloadBar(unit({ ...queue, unitType: UT_CITY }), 100, config),
    ).toBeNull();
  });

  it("shows a level 2 silo with one round fired as one full and one filling pip", () => {
    const pips = reloadBar(
      unit({ unitType: UT_MISSILE_SILO, level: 2, missileTimerQueue: [100] }),
      110,
      config,
    );
    expect(pips).toHaveLength(2);
    expect(pips![0]).toEqual({ fill: 1, ready: true });
    expect(pips![1].ready).toBe(false);
    expect(pips![1].fill).toBeCloseTo(10 / SILO_COOLDOWN);
  });

  it("shows a level 1 SAM's reload as one bar", () => {
    expect(
      reloadBar(unit({ missileTimerQueue: [0] }), SAM_COOLDOWN / 2, config),
    ).toEqual([{ fill: 0.5, ready: false }]);
  });
});

describe("reload bar layout", () => {
  const structure = {
    iconSize: 60,
    dotsZoomThreshold: 1.2,
    iconScaleFactorZoomedOut: 3,
    iconGrowZoom: 7,
  };

  it("is hidden at zooms where structures are dots", () => {
    expect(reloadBarHalfIcon(1.2, structure)).toBe(0);
    expect(reloadBarHalfIcon(0.5, structure)).toBe(0);
  });

  it("is sized like the structure icon", () => {
    // Zoomed out: icons hold a fixed world size.
    expect(reloadBarHalfIcon(2, structure)).toBeCloseTo(10);
    // Mid zoom: a fixed screen size (30 px half-width).
    expect(reloadBarHalfIcon(5, structure)).toBeCloseTo(30 / 5);
    // Zoomed in: world-anchored again.
    expect(reloadBarHalfIcon(14, structure)).toBeCloseTo(30 / 7);
  });

  it("writes one instance per pip, at the unit's tile", () => {
    const mapW = 100;
    const buf = {
      float32: new Float32Array(4 * 6),
      ensureCapacity(n: number) {
        if (n * 6 > this.float32.length) {
          const next = new Float32Array(n * 6 * 2);
          next.set(this.float32);
          this.float32 = next;
        }
      },
    };
    const count = writeReloadBarInstances(
      [
        unit({ id: 1, pos: 3 * mapW + 7, level: 2, missileTimerQueue: [45] }),
        unit({ id: 2, pos: 50 }), // all ready: no bar
        unit({
          id: 3,
          unitType: UT_MISSILE_SILO,
          pos: 9 * mapW + 1,
          missileTimerQueue: [90],
        }),
        unit({ id: 4, level: 3, missileTimerQueue: [0, 0, 0] }),
      ],
      90,
      config,
      mapW,
      buf,
    );
    expect(count).toBe(2 + 1 + 3);
    const at = (i: number) =>
      Array.from(buf.float32.subarray(i * 6, i * 6 + 6));
    // SAM level 2: a ready pip, then one half-way.
    expect(at(0)).toEqual([7, 3, 0, 2, 1, 1]);
    expect(at(1)).toEqual([7, 3, 1, 2, 0.5, 0]);
    // The level 1 silo's one bar, just fired.
    expect(at(2)).toEqual([1, 9, 0, 1, 0, 0]);
    // SAM level 3, every round about to load.
    expect(at(5)).toEqual([0, 0, 2, 3, 1, 0]);
  });
});
