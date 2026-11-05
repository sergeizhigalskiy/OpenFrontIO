/**
 * Moves units along motion plans (transport and trade ships, nukes,
 * trains).
 *
 * The core doesn't send a UnitUpdate for every step of a planned move. It
 * sends the plan once and the client works out each tick's position from
 * it. GameView uses this for the live game, and the replay encoder uses it
 * to store real per-tick positions.
 */

import type { MotionPlanRecord } from "@openfront/engine-lib/game/MotionPlans";

export interface GridMotionPlan {
  planId: number;
  startTick: number;
  ticksPerStep: number;
  path: Uint32Array;
}

interface TrainMotionPlan {
  planId: number;
  speed: number;
  spacing: number;
  /** A copy of the record's: a destroyed car's id is zeroed (unitRemoved). */
  carUnitIds: Uint32Array;
  /**
   * The engine was destroyed this tick (a nuke, say). Cars still active
   * took this tick's step: an engine destroyed before its TrainExecution
   * ran takes every car with it that same tick, so cars only outlive it
   * when it was destroyed after the train moved. They take that step at
   * the next advance, then the plan ends.
   */
  engineLost: boolean;
  path: Uint32Array;
  cursor: number;
  usedTilesBuf: Uint32Array;
  usedHead: number;
  usedLen: number;
  lastAdvancedTick: number;
}

/** How the resolver reads and moves the units it drives. */
export interface PlannedUnits {
  /** The unit's tile, or undefined if it's gone or no longer active. */
  tileOf(id: number): number | undefined;
  /** The unit moved to `tile` this tick. */
  move(id: number, tile: number): void;
  /** The unit stayed where it was this tick. */
  rest(id: number): void;
}

const asUint32 = (a: ArrayLike<number>): Uint32Array =>
  a instanceof Uint32Array ? a : Uint32Array.from(a);

export class MotionPlanResolver {
  private readonly grid = new Map<number, GridMotionPlan>();
  private readonly trains = new Map<number, TrainMotionPlan>();
  private readonly trainUnitToEngine = new Map<number, number>();
  private readonly idsCache: number[] = [];
  private idsDirty = true;

  /** Grid plans by unit id (nuke telegraphs and the attack panel read them). */
  gridPlans(): ReadonlyMap<number, GridMotionPlan> {
    return this.grid;
  }

  /**
   * Whether a grid plan decides this unit's position. The plan's position
   * wins over a UnitUpdate's, which lags behind.
   */
  hasGridPlan(unitId: number): boolean {
    return this.grid.has(unitId);
  }

  /** Every unit a plan moves: grid units, train engines and their cars. */
  plannedUnitIds(): number[] {
    if (this.idsDirty) {
      this.idsDirty = false;
      const out = this.idsCache;
      out.length = 0;
      for (const unitId of this.grid.keys()) out.push(unitId);
      for (const [engineId, plan] of this.trains) {
        if (!plan.engineLost) out.push(engineId);
        for (const carId of plan.carUnitIds) if (carId !== 0) out.push(carId);
      }
    }
    return this.idsCache;
  }

  applyRecords(records: readonly MotionPlanRecord[]): void {
    for (const record of records) {
      if (record.kind === "grid") {
        if (record.ticksPerStep < 1 || record.path.length < 1) continue;
        const existing = this.grid.get(record.unitId);
        if (existing && record.planId <= existing.planId) continue;
        this.grid.set(record.unitId, {
          planId: record.planId,
          startTick: record.startTick,
          ticksPerStep: record.ticksPerStep,
          path: asUint32(record.path),
        });
      } else {
        if (record.speed < 1 || record.path.length < 1) continue;
        const existing = this.trains.get(record.engineUnitId);
        if (existing && record.planId <= existing.planId) continue;
        if (existing) this.clearTrainPlan(record.engineUnitId);
        const carUnitIds = Uint32Array.from(record.carUnitIds);
        this.trains.set(record.engineUnitId, {
          planId: record.planId,
          speed: record.speed,
          spacing: record.spacing,
          carUnitIds,
          engineLost: false,
          path: asUint32(record.path),
          cursor: 0,
          usedTilesBuf: new Uint32Array(
            Math.max(0, carUnitIds.length * record.spacing + 3),
          ),
          usedHead: 0,
          usedLen: 0,
          lastAdvancedTick: record.startTick,
        });
        this.trainUnitToEngine.set(record.engineUnitId, record.engineUnitId);
        for (const carId of carUnitIds) {
          if (carId !== 0)
            this.trainUnitToEngine.set(carId, record.engineUnitId);
        }
      }
      this.idsDirty = true;
    }
  }

  /**
   * A unit went inactive. A grid unit loses its plan. A train goes on
   * without a destroyed car, as TrainExecution does, and one whose engine
   * is gone ends after this tick's advance (see engineLost). A train that
   * arrives loses every unit at once, so it never moves again.
   */
  unitRemoved(unitId: number): void {
    if (this.grid.delete(unitId)) this.idsDirty = true;
    const engineId =
      this.trainUnitToEngine.get(unitId) ??
      (this.trains.has(unitId) ? unitId : undefined);
    if (engineId === undefined) return;
    this.trainUnitToEngine.delete(unitId);
    const plan = this.trains.get(engineId);
    if (plan === undefined) return;
    this.idsDirty = true;
    if (unitId === engineId) {
      plan.engineLost = true;
      return;
    }
    const car = plan.carUnitIds.indexOf(unitId);
    if (car !== -1) plan.carUnitIds[car] = 0;
  }

  /** Drop the train plan a unit drives or rides on, if any. */
  private clearTrainPlan(unitId: number): void {
    const engineId =
      this.trainUnitToEngine.get(unitId) ??
      (this.trains.has(unitId) ? unitId : null);
    if (engineId === null) return;
    this.trainUnitToEngine.delete(unitId);
    const plan = this.trains.get(engineId);
    if (plan === undefined) return;
    this.trains.delete(engineId);
    this.idsDirty = true;
    this.trainUnitToEngine.delete(engineId);
    for (const carId of plan.carUnitIds) {
      if (carId !== 0) this.trainUnitToEngine.delete(carId);
    }
  }

  /** Advance every plan to `tick`. */
  advance(tick: number, units: PlannedUnits): void {
    this.advanceGrid(tick, units);
    this.advanceTrains(tick, units);
  }

  private advanceGrid(tick: number, units: PlannedUnits): void {
    for (const [unitId, plan] of this.grid) {
      const tile = units.tileOf(unitId);
      if (tile === undefined) {
        this.grid.delete(unitId);
        this.idsDirty = true;
        continue;
      }
      const dt = tick - plan.startTick;
      const stepIndex =
        dt <= 0 ? 0 : Math.floor(dt / Math.max(1, plan.ticksPerStep));
      const lastIndex = plan.path.length - 1;
      const newTile = plan.path[Math.max(0, Math.min(lastIndex, stepIndex))];
      if (newTile !== tile) {
        units.move(unitId, newTile);
        continue;
      }
      units.rest(unitId);
      // Past the last step the unit stays put, so the plan is done. Dropping
      // it stops marking a unit that doesn't move as updated every tick.
      if (dt > 0 && stepIndex >= lastIndex) {
        this.grid.delete(unitId);
        this.idsDirty = true;
      }
    }
  }

  private advanceTrains(tick: number, units: PlannedUnits): void {
    const stale: number[] = [];
    for (const [engineId, plan] of this.trains) {
      if (!plan.engineLost && units.tileOf(engineId) === undefined) {
        stale.push(engineId);
        continue;
      }
      const steps = tick - plan.lastAdvancedTick;
      if (steps <= 0) {
        if (plan.engineLost) stale.push(engineId);
        continue;
      }

      const { path } = plan;
      const lastIndex = path.length - 1;
      const cap = plan.usedTilesBuf.length;
      const pushUsed = (tile: number) => {
        if (cap === 0) return;
        if (plan.usedLen < cap) {
          plan.usedTilesBuf[(plan.usedHead + plan.usedLen) % cap] = tile;
          plan.usedLen++;
        } else {
          plan.usedTilesBuf[plan.usedHead] = tile;
          plan.usedHead = (plan.usedHead + 1) % cap;
        }
      };
      const usedGet = (index: number): number | null =>
        index < 0 || index >= plan.usedLen || cap === 0
          ? null
          : plan.usedTilesBuf[(plan.usedHead + index) % cap];

      let didMove = false;
      for (let step = 0; step < steps; step++) {
        const cursor = plan.cursor;
        if (cursor >= lastIndex) break;
        for (let i = 0; i < plan.speed && cursor + i < path.length; i++) {
          pushUsed(path[cursor + i]);
        }
        plan.cursor = Math.min(lastIndex, cursor + plan.speed);

        for (let i = plan.carUnitIds.length - 1; i >= 0; --i) {
          const carId = plan.carUnitIds[i];
          if (carId === 0) continue;
          const carTile = units.tileOf(carId);
          if (carTile === undefined) continue;
          const tile = usedGet((i + 1) * plan.spacing + 2);
          if (tile !== null && tile !== carTile) {
            units.move(carId, tile);
            didMove = true;
          }
        }

        // A lost engine's last position came with its Unit update.
        if (plan.engineLost) continue;
        const newEngineTile = path[plan.cursor];
        if (newEngineTile !== units.tileOf(engineId)) {
          units.move(engineId, newEngineTile);
          didMove = true;
        }
      }
      plan.lastAdvancedTick = tick;
      // The plan stays for the tick the train stops (so it's redrawn there),
      // and goes once it no longer moves. Trains are normally removed with
      // their last Unit update first; this is a fallback.
      if (plan.engineLost || (!didMove && plan.cursor >= lastIndex)) {
        stale.push(engineId);
      }
    }
    for (const engineId of stale) this.clearTrainPlan(engineId);
  }
}
