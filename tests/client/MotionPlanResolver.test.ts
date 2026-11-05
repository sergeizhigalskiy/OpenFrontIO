import {
  MotionPlanResolver,
  type PlannedUnits,
} from "../../src/client/view/MotionPlanResolver";

/** Units as positions, with a log of what the resolver did. */
function units(ids: number[], start = 0) {
  const pos = new Map(ids.map((id) => [id, start]));
  const rested: number[] = [];
  const store: PlannedUnits = {
    tileOf: (id) => pos.get(id),
    move: (id, tile) => pos.set(id, tile),
    rest: (id) => rested.push(id),
  };
  return { pos, rested, store };
}

const grid = (planId: number, startTick: number, path: number[]) => ({
  kind: "grid" as const,
  unitId: 1,
  planId,
  startTick,
  ticksPerStep: 2,
  path,
});

describe("MotionPlanResolver", () => {
  test("a grid plan waits for its start, steps, and ends at the last tile", () => {
    const r = new MotionPlanResolver();
    const u = units([1], 10);
    r.applyRecords([grid(1, 5, [10, 11, 12])]);
    expect(r.plannedUnitIds()).toEqual([1]);

    const at = (tick: number) => {
      r.advance(tick, u.store);
      return u.pos.get(1);
    };
    expect([at(4), at(6), at(7), at(9)]).toEqual([10, 10, 11, 12]);
    expect(u.rested).toEqual([1, 1]);
    // Past the end it rests once more, then the plan is dropped.
    expect(at(20)).toBe(12);
    expect(r.hasGridPlan(1)).toBe(false);
    expect(r.plannedUnitIds()).toEqual([]);
  });

  test("an older plan is ignored, a newer one replaces it", () => {
    const r = new MotionPlanResolver();
    const u = units([1]);
    r.applyRecords([grid(2, 0, [0, 50])]);
    r.applyRecords([grid(1, 0, [0, 99])]);
    r.advance(2, u.store);
    expect(u.pos.get(1)).toBe(50);
    r.applyRecords([grid(3, 2, [50, 60])]);
    r.advance(4, u.store);
    expect(u.pos.get(1)).toBe(60);
  });

  test("a unit that's gone loses its plan", () => {
    const r = new MotionPlanResolver();
    const u = units([]);
    r.applyRecords([grid(1, 0, [0, 1])]);
    r.advance(2, u.store);
    expect(r.hasGridPlan(1)).toBe(false);
  });

  test("train cars follow the engine along its path", () => {
    const r = new MotionPlanResolver();
    const u = units([1, 2, 3]);
    const path = Array.from({ length: 40 }, (_, i) => i);
    r.applyRecords([
      {
        kind: "train",
        engineUnitId: 1,
        carUnitIds: [2, 3],
        planId: 1,
        startTick: 0,
        speed: 2,
        spacing: 2,
        path,
      },
    ]);
    expect(r.plannedUnitIds()).toEqual([1, 2, 3]);
    for (let tick = 1; tick <= 8; tick++) r.advance(tick, u.store);
    const [engine, car1, car2] = [1, 2, 3].map((id) => u.pos.get(id)!);
    expect(engine).toBe(16);
    // Both behind the engine, `spacing` tiles apart.
    expect(Math.max(car1, car2)).toBeLessThan(engine);
    expect(Math.abs(car1 - car2)).toBe(2);

    // Once every unit is gone (it arrived), the plan goes without a move.
    for (const id of [1, 2, 3]) {
      r.unitRemoved(id);
      u.pos.delete(id);
    }
    expect(r.plannedUnitIds()).toEqual([]);
    r.advance(9, u.store);
    expect(r.plannedUnitIds()).toEqual([]);
  });

  /** Engine 1 and cars 2-4 on a straight path, advanced to tick 8. */
  function movingTrain() {
    const r = new MotionPlanResolver();
    const u = units([1, 2, 3, 4]);
    r.applyRecords([
      {
        kind: "train",
        engineUnitId: 1,
        carUnitIds: Uint32Array.from([2, 3, 4]),
        planId: 1,
        startTick: 0,
        speed: 2,
        spacing: 2,
        path: Array.from({ length: 60 }, (_, i) => i),
      },
    ]);
    for (let tick = 1; tick <= 8; tick++) r.advance(tick, u.store);
    return { r, u };
  }

  test("a train goes on without a destroyed car", () => {
    const { r, u } = movingTrain();
    const before = [1, 2, 4].map((id) => u.pos.get(id)!);
    // A nuke takes the middle car; TrainExecution keeps the rest moving.
    r.unitRemoved(3);
    u.pos.delete(3);
    expect(r.plannedUnitIds()).toEqual([1, 2, 4]);
    r.advance(9, u.store);
    expect([1, 2, 4].map((id) => u.pos.get(id)!)).toEqual(
      before.map((p) => p + 2),
    );
  });

  test("cars that outlive their engine take that tick's step, then stop", () => {
    const { r, u } = movingTrain();
    const before = [2, 3].map((id) => u.pos.get(id)!);
    // The engine and its last car were destroyed after the train moved on
    // tick 9 (the engine's update carries where it got to).
    for (const id of [1, 4]) {
      r.unitRemoved(id);
      u.pos.delete(id);
    }
    expect(r.plannedUnitIds()).toEqual([2, 3]);
    r.advance(9, u.store);
    expect([2, 3].map((id) => u.pos.get(id)!)).toEqual(
      before.map((p) => p + 2),
    );
    // TrainExecution removes them on its next tick; until then they stay.
    expect(r.plannedUnitIds()).toEqual([]);
    r.advance(10, u.store);
    expect([2, 3].map((id) => u.pos.get(id)!)).toEqual(
      before.map((p) => p + 2),
    );
  });

  test("the record's car list is left alone", () => {
    const r = new MotionPlanResolver();
    const carUnitIds = Uint32Array.from([2, 3]);
    r.applyRecords([
      {
        kind: "train",
        engineUnitId: 1,
        carUnitIds,
        planId: 1,
        startTick: 0,
        speed: 2,
        spacing: 2,
        path: [0, 1, 2, 3],
      },
    ]);
    r.unitRemoved(3);
    expect([...carUnitIds]).toEqual([2, 3]);
  });
});
