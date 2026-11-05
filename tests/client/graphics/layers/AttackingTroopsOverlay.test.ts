import { Cell } from "@openfront/engine-api/game/GameTypes";
import { describe, expect, test } from "vitest";
import {
  alignClusterOrder,
  AttackingTroopsController,
  Slot,
} from "../../../../src/client/controllers/AttackingTroopsController";

// Slots only need the `dst` fields populated for `alignClusterOrder` — it
// compares the new positions against the previous targets to decide whether
// the worker reordered same-size clusters.
const slot = (x: number, y: number): Slot => ({
  curX: x,
  curY: y,
  srcX: x,
  srcY: y,
  dstX: x,
  dstY: y,
  startMs: 0,
});

describe("alignClusterOrder", () => {
  const c = (x: number, y: number) => new Cell(x, y);

  test("preserves order when direct mapping is closer", () => {
    const next = [c(10, 10), c(100, 100)];
    const prev = [slot(12, 11), slot(98, 102)];
    alignClusterOrder(next, prev);
    expect(next[0].x).toBe(10);
    expect(next[1].x).toBe(100);
  });

  test("swaps when the worker reordered same-size clusters", () => {
    // prev[0] is near (10,10), prev[1] is near (100,100); the worker returned
    // them in the opposite order. Expect swap so each label sticks to its front.
    const next = [c(101, 99), c(11, 12)];
    const prev = [slot(10, 10), slot(100, 100)];
    alignClusterOrder(next, prev);
    expect(next[0].x).toBe(11);
    expect(next[1].x).toBe(101);
  });

  test("does not swap on a tie (strict less-than)", () => {
    const next = [c(0, 0), c(10, 0)];
    const prev = [slot(5, 0), slot(5, 0)];
    alignClusterOrder(next, prev);
    expect(next[0].x).toBe(0);
    expect(next[1].x).toBe(10);
  });

  test("no-op when fewer than two new positions", () => {
    const single = [c(99, 99)];
    alignClusterOrder(single, [slot(0, 0), slot(1000, 1000)]);
    expect(single[0].x).toBe(99);

    const empty: Cell[] = [];
    alignClusterOrder(empty, [slot(0, 0), slot(1000, 1000)]);
    expect(empty.length).toBe(0);
  });

  test("no-op when fewer than two previous slots (initial render)", () => {
    const next = [c(100, 100), c(0, 0)];
    alignClusterOrder(next, [slot(0, 0)]);
    expect(next[0].x).toBe(100);
    expect(next[1].x).toBe(0);

    alignClusterOrder(next, []);
    expect(next[0].x).toBe(100);
    expect(next[1].x).toBe(0);
  });

  test("no-op when more than two new positions (assumed cap)", () => {
    const next = [c(100, 0), c(0, 0), c(50, 0)];
    alignClusterOrder(next, [slot(0, 0), slot(100, 0)]);
    expect(next.map((p) => p.x)).toEqual([100, 0, 50]);
  });
});

describe("pushLabels buffer reuse", () => {
  test("reuses the same labelBuf array and objects across frames", () => {
    let captured: unknown[] = [];
    const view = { setAttackTroopLabels: (l: unknown[]) => (captured = l) };
    // Off the map, so no fog check applies.
    const game = { isValidCoord: () => false };
    const ctrl = new (AttackingTroopsController as any)(game, {}, {}, view);
    ctrl.attacks.set("a", {
      text: "1",
      isIncoming: true,
      attackerID: 3,
      slots: [
        { curX: 0, curY: 0, srcX: 0, srcY: 0, dstX: 1, dstY: 1, startMs: 0 },
      ],
    });
    ctrl.pushLabels();
    const firstBuf = captured;
    const firstItem = captured[0];
    ctrl.pushLabels();
    expect(captured).toBe(firstBuf);
    expect(captured[0]).toBe(firstItem);

    ctrl.attacks.clear();
    ctrl.pushLabels();
    expect(captured.length).toBe(0);

    ctrl.attacks.set("a", {
      text: "2",
      isIncoming: false,
      attackerID: 0,
      slots: [
        { curX: 1, curY: 1, srcX: 0, srcY: 0, dstX: 2, dstY: 2, startMs: 0 },
      ],
    });
    ctrl.pushLabels();
    expect(captured.length).toBe(1);
    expect(captured[0]).toBe(firstItem);
  });
});

describe("fog over attack labels", () => {
  test("hides an incoming attack's troops inside fog, never my own attack's", () => {
    let captured: { text: string }[] = [];
    const view = {
      setAttackTroopLabels: (l: { text: string }[]) => (captured = l),
    };
    const attacker = { isPlayer: () => true };
    const fogged: unknown[][] = [];
    const game = {
      isValidCoord: () => true,
      ref: (x: number, y: number) => y * 100 + x,
      playerBySmallID: () => attacker,
      fogHidesTroops: (...args: unknown[]) => {
        fogged.push(args);
        return true;
      },
    };
    const ctrl = new (AttackingTroopsController as any)(game, {}, {}, view);
    const slot = { curX: 5, curY: 7, srcX: 5, srcY: 7, dstX: 5, dstY: 7 };
    ctrl.attacks.set("in", {
      text: "12K",
      isIncoming: true,
      attackerID: 3,
      slots: [{ ...slot, startMs: 0 }],
    });
    ctrl.attacks.set("out", {
      text: "9K",
      isIncoming: false,
      attackerID: 0,
      slots: [{ ...slot, startMs: 0 }],
    });
    ctrl.pushLabels();
    expect(captured.map((l) => l.text)).toEqual(["?", "9K"]);
    expect(fogged).toEqual([[705, attacker]]);
  });
});
