import { AIRBASE_SORTIE_RECHARGE_TICKS } from "@openfront/engine-lib/game/ConventionalWar";
import { zRef } from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * An airbase: a land structure holding one sortie (conventional war only).
 *
 * An airstrike or airdrop flown from it spends the sortie (Unit.launch, the
 * same queue a missile silo uses); this recharges it AIRBASE_SORTIE_RECHARGE_TICKS
 * later. It is captured with its tile like any structure.
 */
export class AirbaseExecution implements Execution {
  private active = true;
  private mg: Game;

  constructor(private airbase: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    if (!this.airbase.isActive()) {
      this.active = false;
      return;
    }
    if (this.airbase.isUnderConstruction()) return;

    // The tick the sortie was flown.
    const flownAt = this.airbase.missileTimerQueue()[0];
    if (flownAt === undefined) return;
    if (this.mg.ticks() - flownAt >= AIRBASE_SORTIE_RECHARGE_TICKS) {
      this.airbase.reloadMissile();
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirbaseExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      airbase: w.unit(this.airbase),
    });
  }

  restoreSnapshot(s: AirbaseState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.airbase = r.unit(s.airbase);
  }
}

const AirbaseStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  airbase: zRef(),
});
type AirbaseState = z.infer<typeof AirbaseStateSchema>;

export const AirbaseExecutionSnapshot = execSnapshotType({
  name: "Airbase",
  version: 1,
  schema: AirbaseStateSchema,
  cls: () => AirbaseExecution,
});
