import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  COASTAL_BATTERY_RANGE,
  COASTAL_BATTERY_RELOAD_TICKS,
} from "@openfront/engine-lib/game/NavalDefense";
import { zInt, zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  isHostileShip,
  NAVAL_DEFENSE_TARGET_TYPES,
} from "./MinefieldExecution";
import { ShellExecution } from "./ShellExecution";

/**
 * A coastal battery: a shore structure that shells hostile ships.
 *
 * Every COASTAL_BATTERY_RELOAD_TICKS it fires one shell (the same
 * ShellExecution and damage warships use) at a hostile warship, transport ship
 * or convoy at sea within COASTAL_BATTERY_RANGE tiles. It picks a warship
 * shelling it first, then transport ships and convoys, then other warships,
 * nearest first. Warships shell batteries back (WarshipExecution); a battery
 * at 0 health is destroyed. It is captured with its tile like any structure.
 */
export class CoastalBatteryExecution implements Execution {
  private mg: Game;
  private active = true;
  private lastShellAttack = -COASTAL_BATTERY_RELOAD_TICKS;
  /**
   * Targets that die to one shell (transport ships; convoys lose a share of
   * their troops per shell), so they get just one each.
   */
  private alreadySentShell = new Set<Unit>();

  constructor(private battery: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.battery.isActive()) {
      this.active = false;
      return;
    }
    if (this.battery.isUnderConstruction()) return;

    for (const unit of this.alreadySentShell) {
      if (!unit.isActive()) this.alreadySentShell.delete(unit);
    }
    if (this.mg.ticks() - this.lastShellAttack < COASTAL_BATTERY_RELOAD_TICKS) {
      return;
    }
    const target = this.findTarget();
    if (target === null) return;

    this.lastShellAttack = this.mg.ticks();
    this.mg.addExecution(
      new ShellExecution(
        this.battery.tile(),
        this.battery.owner(),
        this.battery,
        target,
      ),
    );
    if (!target.hasHealth()) {
      this.alreadySentShell.add(target);
    }
  }

  /**
   * The best hostile ship in range: one shelling this battery, else a
   * transport ship or convoy, else a warship. Nearest first, then lowest id.
   */
  private findTarget(): Unit | null {
    const owner = this.battery.owner();
    let best: Unit | null = null;
    let bestPriority = 0;
    let bestDist = 0;
    for (const { unit, distSquared } of this.mg.nearbyUnits(
      this.battery.tile(),
      COASTAL_BATTERY_RANGE,
      NAVAL_DEFENSE_TARGET_TYPES,
    )) {
      if (
        this.alreadySentShell.has(unit) ||
        !isHostileShip(this.mg, owner, unit)
      ) {
        continue;
      }
      const priority =
        unit.targetUnit() === this.battery
          ? 0
          : unit.type() === UnitType.Warship
            ? 2
            : 1;
      if (
        best === null ||
        priority < bestPriority ||
        (priority === bestPriority &&
          (distSquared < bestDist ||
            (distSquared === bestDist && unit.id() < best.id())))
      ) {
        best = unit;
        bestPriority = priority;
        bestDist = distSquared;
      }
    }
    return best;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return CoastalBatteryExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      battery: w.unit(this.battery),
      lastShellAttack: this.lastShellAttack,
      alreadySentShell: [...this.alreadySentShell].map((u) => w.unit(u)),
    });
  }

  restoreSnapshot(s: CoastalBatteryState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.battery = r.unit(s.battery);
    this.lastShellAttack = s.lastShellAttack;
    this.alreadySentShell = new Set(s.alreadySentShell.map((i) => r.unit(i)));
  }
}

const CoastalBatteryStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  battery: zRef(),
  lastShellAttack: zInt(),
  /** In insertion order. */
  alreadySentShell: z.array(zRef()),
});
type CoastalBatteryState = z.infer<typeof CoastalBatteryStateSchema>;

export const CoastalBatteryExecutionSnapshot = execSnapshotType({
  name: "CoastalBattery",
  version: 1,
  schema: CoastalBatteryStateSchema,
  cls: () => CoastalBatteryExecution,
});
