import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Tick, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  WeatherCell,
  WeatherKind,
} from "@openfront/engine-api/game/GameUpdates";
import {
  activeCellAt,
  cellCovers,
  isCellActive,
  mudTileCostMultiplier,
  planWeatherCell,
  stormTroopLoss,
  WEATHER_MAX_CELLS,
  WEATHER_MIN_CELLS,
  WEATHER_SPAWN_GAP_MAX_TICKS,
  WEATHER_SPAWN_GAP_MIN_TICKS,
  WEATHER_WARNING_TICKS,
} from "@openfront/engine-lib/game/Weather";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zRandom,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { StormMove, WeatherSystem } from "../game/WeatherSystem";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/** Ticks between the full cell list updates a late view catches up from. */
const RESEND_TICKS = 10;

/** What one transport or sea convoy has lost to one storm. */
interface StormLoss {
  cell: number;
  unit: Unit;
  /** Its troops when the storm first caught it. */
  entryTroops: number;
  lost: number;
}

/**
 * Weather systems (see engine-lib/game/Weather.ts): keeps WEATHER_MIN_CELLS
 * to WEATHER_MAX_CELLS cells alive, drawn from its own seeded PRNG, and
 * applies the sea storms' troop loss. Other executions read it through
 * Game.weather(): attacks for mud, ships for the storm slowdown. Fog has no
 * engine effect.
 *
 * Added by GameRunner.init when the game config has weather on. Starts on
 * the first tick after the spawn phase.
 */
export class WeatherExecution implements Execution, WeatherSystem {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private _cells: WeatherCell[] = [];
  private nextCellId = 1;
  /** An extra cell (above the minimum) may be announced from this tick. */
  private nextSpawnTick: Tick = 0;
  /** Ships stormMove last found slowed, so it can report the change. */
  private slowedShips = new Set<Unit>();
  /** Troops lost per (storm, unit), for the per-storm cap. */
  private stormLosses: StormLoss[] = [];

  /**
   * @param autoSpawn false for scripted weather: only addCell adds cells.
   */
  constructor(
    seed: number,
    private autoSpawn = true,
  ) {
    this.random = new PseudoRandom(seed);
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    mg.setWeather(this);
  }

  /** Announces `cell` (scripted weather and tests). */
  addCell(cell: WeatherCell): void {
    this._cells.push({ ...cell });
    this.nextCellId = Math.max(this.nextCellId, cell.id + 1);
    if (this.mg !== undefined) this.sendCells();
  }

  tick(ticks: number): void {
    let changed = this.expire(ticks);
    if (this.autoSpawn && this.maybeSpawn(ticks)) changed = true;
    this.applyStormLosses(ticks);
    if (changed || ticks % RESEND_TICKS === 0) this.sendCells();
  }

  /** Drops cells past their end, and what they were tracking. */
  private expire(ticks: number): boolean {
    const before = this._cells.length;
    this._cells = this._cells.filter((c) => c.endTick > ticks);
    for (const ship of this.slowedShips) {
      if (!ship.isActive()) this.slowedShips.delete(ship);
    }
    this.stormLosses = this.stormLosses.filter(
      (l) => l.unit.isActive() && this._cells.some((c) => c.id === l.cell),
    );
    return this._cells.length !== before;
  }

  /**
   * At most one new cell a tick: whenever fewer than WEATHER_MIN_CELLS would
   * still be alive once a cell announced now takes effect, and otherwise on
   * the seeded schedule. Never more than WEATHER_MAX_CELLS at once.
   */
  private maybeSpawn(ticks: number): boolean {
    if (this._cells.length >= WEATHER_MAX_CELLS) return false;
    const lasting = this._cells.filter(
      (c) => c.endTick > ticks + WEATHER_WARNING_TICKS,
    ).length;
    if (lasting >= WEATHER_MIN_CELLS && ticks < this.nextSpawnTick) {
      return false;
    }
    this._cells.push(
      planWeatherCell(this.random, this.mg.map(), this.nextCellId++, ticks),
    );
    this.nextSpawnTick =
      ticks +
      this.random.nextInt(
        WEATHER_SPAWN_GAP_MIN_TICKS,
        WEATHER_SPAWN_GAP_MAX_TICKS + 1,
      );
    return true;
  }

  /** Transports and sea convoys in an active storm lose troops, up to the cap. */
  private applyStormLosses(ticks: number): void {
    const storms = this._cells.filter(
      (c) => c.kind === WeatherKind.Storm && isCellActive(c, ticks),
    );
    if (storms.length === 0) return;
    for (const unit of this.mg.units(UnitType.TransportShip, UnitType.Convoy)) {
      const tile = unit.tile();
      if (!this.mg.isWater(tile)) continue;
      const x = this.mg.x(tile);
      const y = this.mg.y(tile);
      for (const cell of storms) {
        if (!cellCovers(cell, ticks, x, y)) continue;
        let loss = this.stormLosses.find(
          (l) => l.cell === cell.id && l.unit === unit,
        );
        if (loss === undefined) {
          loss = { cell: cell.id, unit, entryTroops: unit.troops(), lost: 0 };
          this.stormLosses.push(loss);
        }
        const amount = Math.min(
          stormTroopLoss(loss.entryTroops, loss.lost),
          unit.troops(),
        );
        if (amount <= 0) continue;
        unit.setTroops(unit.troops() - amount);
        loss.lost += amount;
      }
    }
  }

  private sendCells(): void {
    this.mg.addUpdate({
      type: GameUpdateType.Weather,
      cells: this._cells.map((c) => ({ ...c })),
    });
  }

  cells(): readonly WeatherCell[] {
    return this._cells;
  }

  attackTileCostMultiplier(tile: TileRef): number {
    return mudTileCostMultiplier(
      this._cells,
      this.mg.ticks(),
      this.mg.x(tile),
      this.mg.y(tile),
    );
  }

  inStorm(tile: TileRef): boolean {
    return (
      this.mg.isWater(tile) &&
      activeCellAt(
        this._cells,
        this.mg.ticks(),
        this.mg.x(tile),
        this.mg.y(tile),
        WeatherKind.Storm,
      ) !== null
    );
  }

  stormMove(ship: Unit, tick: Tick): StormMove {
    const slowed = this.inStorm(ship.tile());
    const was = this.slowedShips.has(ship);
    if (slowed && !was) this.slowedShips.add(ship);
    else if (!slowed && was) this.slowedShips.delete(ship);
    return { slowed, hold: slowed && tick % 2 === 1, changed: slowed !== was };
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return WeatherExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      autoSpawn: this.autoSpawn,
      random: w.random(this.random),
      cells: this._cells.map((c) => ({ ...c })),
      nextCellId: this.nextCellId,
      nextSpawnTick: this.nextSpawnTick,
      slowedShips: [...this.slowedShips].map((u) => w.unit(u)),
      stormLosses: this.stormLosses.map((l) => ({
        cell: l.cell,
        unit: w.unit(l.unit),
        entryTroops: l.entryTroops,
        lost: l.lost,
      })),
    });
  }

  restoreSnapshot(s: WeatherState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.autoSpawn = s.autoSpawn;
    this.random = r.random(s.random);
    this._cells = s.cells.map((c) => ({ ...c, kind: c.kind as WeatherKind }));
    this.nextCellId = s.nextCellId;
    this.nextSpawnTick = s.nextSpawnTick;
    this.slowedShips = new Set(s.slowedShips.map((i) => r.unit(i)));
    this.stormLosses = s.stormLosses.map((l) => ({
      cell: l.cell,
      unit: r.unit(l.unit),
      entryTroops: l.entryTroops,
      lost: l.lost,
    }));
  }
}

const WeatherCellSchema = z.object({
  id: zInt(),
  kind: zInt(),
  x: zNum(),
  y: zNum(),
  dx: zNum(),
  dy: zNum(),
  radius: zNum(),
  announceTick: zInt(),
  activeTick: zInt(),
  endTick: zInt(),
});

const WeatherStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  autoSpawn: z.boolean(),
  random: zRandom(),
  cells: z.array(WeatherCellSchema),
  nextCellId: zInt(),
  nextSpawnTick: zInt(),
  // Insertion order: iterated when pruning.
  slowedShips: z.array(zRef()),
  stormLosses: z.array(
    z.object({
      cell: zInt(),
      unit: zRef(),
      entryTroops: zNum(),
      lost: zNum(),
    }),
  ),
});
type WeatherState = z.infer<typeof WeatherStateSchema>;

export const WeatherExecutionSnapshot = execSnapshotType({
  name: "Weather",
  version: 1,
  schema: WeatherStateSchema,
  cls: () => WeatherExecution,
});
