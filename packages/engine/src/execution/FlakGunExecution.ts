import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  FLAK_DRONE_REPORT_INTERVAL_TICKS,
  FLAK_GUN_HIT_PERCENT,
  FLAK_GUN_RANGE,
  FLAK_GUN_RELOAD_TICKS,
  FLAK_ROUNDS,
  FLAK_TARGET_TYPES,
} from "@openfront/engine-lib/game/ConventionalWar";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zPlayerRef,
  zRandom,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/** The translation key naming a plane in flak messages. */
function planeKey(type: UnitType): string {
  return type === UnitType.Airdrop
    ? "unit_type.airdrop"
    : "unit_type.airstrike";
}

/**
 * A flak gun: cheap anti-aircraft on land (conventional war only).
 *
 * It holds FLAK_ROUNDS rounds, each reloading FLAK_GUN_RELOAD_TICKS after it
 * is fired (the unit's missile timer queue, as for a SAM, so the timers are in
 * the unit's snapshot). Whenever a round is loaded it fires one, at most one
 * per tick, at a hostile airstrike or airdrop plane or drone within
 * FLAK_GUN_RANGE tiles: first a drone diving at this gun, nearest first, else
 * the nearest target. A round shoots it down FLAK_GUN_HIT_PERCENT of the time
 * (a seeded roll); a miss still uses the round, so several guns layer up and
 * a swarm bigger than the rounds gets through. With every round reloading it
 * can't fire. It never fires at cruise missiles, nukes, ships or anything
 * else. It is captured with its tile like any structure.
 *
 * Planes shot down are reported at once. Drones are counted and reported at
 * most once per FLAK_DRONE_REPORT_INTERVAL_TICKS, so a swarm doesn't flood
 * the event log.
 */
export class FlakGunExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  /** Drones shot down since the last report, per drone owner. */
  private dronesDowned = new Map<Player, number>();
  private lastDroneReportTick = -FLAK_DRONE_REPORT_INTERVAL_TICKS;

  constructor(private gun: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    // Seeded per gun so guns firing on the same tick roll differently.
    this.random = new PseudoRandom(this.gun.id() * 7919 + 17);
  }

  tick(ticks: number): void {
    if (!this.gun.isActive()) {
      this.reportDrones();
      this.active = false;
      return;
    }
    if (
      this.dronesDowned.size > 0 &&
      this.mg.ticks() - this.lastDroneReportTick >=
        FLAK_DRONE_REPORT_INTERVAL_TICKS
    ) {
      this.reportDrones();
    }
    if (this.gun.isUnderConstruction()) return;

    // Reload every round whose timer has run out (oldest first).
    const timers = this.gun.missileTimerQueue();
    while (
      timers.length > 0 &&
      this.mg.ticks() - timers[0] >= FLAK_GUN_RELOAD_TICKS
    ) {
      this.gun.reloadMissile();
    }
    if (this.gun.missileTimerQueue().length >= FLAK_ROUNDS) return;

    const target = this.findTarget();
    if (target === null) return;

    // One round: a miss still uses it.
    this.gun.launch();
    if (this.random.nextInt(0, 100) >= FLAK_GUN_HIT_PERCENT) return;

    const owner = this.gun.owner();
    const victim = target.owner();
    target.delete(true, owner);
    if (target.type() === UnitType.Drone) {
      this.dronesDowned.set(victim, (this.dronesDowned.get(victim) ?? 0) + 1);
      return;
    }
    const unit = planeKey(target.type());
    this.mg.displayMessage(
      "events_display.plane_shot_down_by_flak",
      MessageType.SAM_HIT,
      victim.id(),
      undefined,
      { unit, name: owner.displayName() },
      undefined,
      owner.id(),
    );
    this.mg.displayMessage(
      "events_display.flak_shot_down_plane",
      MessageType.SAM_HIT,
      owner.id(),
      undefined,
      { unit, name: victim.displayName() },
      undefined,
      victim.id(),
    );
  }

  /** Reports the drones shot down since the last report, to both sides. */
  private reportDrones(): void {
    if (this.dronesDowned.size === 0) return;
    const owner = this.gun.owner();
    this.lastDroneReportTick = this.mg.ticks();
    for (const [victim, count] of this.dronesDowned) {
      this.mg.displayMessage(
        "events_display.flak_shot_down_drones",
        MessageType.SAM_HIT,
        owner.id(),
        undefined,
        { count, name: victim.displayName() },
        undefined,
        victim.id(),
      );
      this.mg.displayMessage(
        "events_display.drones_shot_down_by_flak",
        MessageType.SAM_HIT,
        victim.id(),
        undefined,
        { count, name: owner.displayName() },
        undefined,
        owner.id(),
      );
    }
    this.dronesDowned.clear();
  }

  /**
   * A drone diving at this gun, nearest first, else the nearest hostile plane
   * or drone in range. Ties go to the lowest id.
   */
  private findTarget(): Unit | null {
    const owner = this.gun.owner();
    let best: Unit | null = null;
    let bestPriority = 0;
    let bestDist = 0;
    for (const { unit, distSquared } of this.mg.nearbyUnits(
      this.gun.tile(),
      FLAK_GUN_RANGE,
      FLAK_TARGET_TYPES,
    )) {
      const unitOwner = unit.owner();
      if (unitOwner === owner || owner.isFriendly(unitOwner, true)) continue;
      const priority =
        unit.type() === UnitType.Drone && unit.targetUnit() === this.gun
          ? 0
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
    return FlakGunExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      gun: w.unit(this.gun),
      random: this.random === undefined ? null : w.random(this.random),
      dronesDowned: [...this.dronesDowned].map(([player, count]) => ({
        player: w.player(player),
        count,
      })),
      lastDroneReportTick: this.lastDroneReportTick,
    });
  }

  restoreSnapshot(s: FlakGunState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.gun = r.unit(s.gun);
    if (s.random !== null) this.random = r.random(s.random);
    this.dronesDowned = new Map(
      s.dronesDowned.map(({ player, count }) => [r.player(player), count]),
    );
    this.lastDroneReportTick = s.lastDroneReportTick;
  }
}

const FlakGunStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  gun: zRef(),
  random: zRandom().nullable(),
  /** In insertion order. */
  dronesDowned: z.array(z.object({ player: zPlayerRef(), count: zInt() })),
  lastDroneReportTick: zInt(),
});
type FlakGunState = z.infer<typeof FlakGunStateSchema>;

export const FlakGunExecutionSnapshot = execSnapshotType({
  name: "FlakGun",
  version: 1,
  schema: FlakGunStateSchema,
  cls: () => FlakGunExecution,
});
