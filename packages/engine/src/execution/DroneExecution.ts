import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  clampDroneSwarm,
  DRONE_MAX_FLIGHT_TICKS,
  DRONE_RETARGET_RADIUS,
  DRONE_SPEED,
  DRONE_TARGET_TYPES,
  droneWarshipDamage,
} from "@openfront/engine-lib/game/ConventionalWar";
import {
  zInt,
  zPlayerRef,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import {
  canLaunchDrone,
  droneAirbases,
  droneTargetAt,
  isDroneTarget,
} from "../game/AirOps";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

/**
 * The nearest valid drone target for `player` within DRONE_RETARGET_RADIUS of
 * `tile`, ties to the lowest id, or null.
 */
function retarget(game: Game, player: Player, tile: TileRef): Unit | null {
  let best: Unit | null = null;
  let bestDist = 0;
  for (const { unit, distSquared } of game.nearbyUnits(
    tile,
    DRONE_RETARGET_RADIUS,
    DRONE_TARGET_TYPES,
    undefined,
    true,
  )) {
    if (!isDroneTarget(game, player, unit)) continue;
    if (
      best === null ||
      distSquared < bestDist ||
      (distSquared === bestDist && unit.id() < best.id())
    ) {
      best = unit;
      bestDist = distSquared;
    }
  }
  return best;
}

/** `current` while it is still a valid target, else a new one nearby. */
function liveTarget(
  game: Game,
  player: Player,
  current: Unit | null,
  near: TileRef,
): Unit | null {
  if (current !== null && isDroneTarget(game, player, current)) return current;
  return retarget(game, player, near);
}

/**
 * A drone swarm order (conventional war only): `count` drones at the target
 * nearest the clicked tile. Every airbase within DRONE_RANGE of the target
 * launches at most one drone per DRONE_LAUNCH_INTERVAL_TICKS, and the order
 * waits until all are out. Each drone is paid for as it takes off; the order
 * stops when the gold runs out. If the target is destroyed or captured before
 * the swarm is out, the rest go for the nearest valid target within
 * DRONE_RETARGET_RADIUS, or the order ends.
 */
export class DroneSwarmExecution implements Execution {
  private active = true;
  private mg: Game;
  private target: Unit | null = null;
  /** Where the target was last seen, to retarget around. */
  private lastTargetTile: TileRef | null = null;
  private remaining: number;

  constructor(
    private player: Player,
    private tile: TileRef,
    count: number,
  ) {
    this.remaining = clampDroneSwarm(count);
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
  }

  tick(ticks: number): void {
    const mg = this.mg;
    const player = this.player;
    if (
      mg.config().isUnitDisabled(UnitType.Drone) ||
      !player.isAlive() ||
      mg.isSpawnImmunityActive()
    ) {
      this.active = false;
      return;
    }
    this.target =
      this.lastTargetTile === null
        ? droneTargetAt(mg, player, this.tile)
        : liveTarget(mg, player, this.target, this.lastTargetTile);
    if (this.target === null) {
      this.active = false;
      return;
    }
    this.lastTargetTile = this.target.tile();

    const bases = droneAirbases(mg, player, this.target.tile());
    if (bases.length === 0) {
      this.active = false;
      return;
    }
    for (const base of bases) {
      if (this.remaining === 0) break;
      if (!canLaunchDrone(mg, base)) continue;
      const cost = mg.unitInfo(UnitType.Drone).cost(mg, player);
      if (player.gold() < cost) {
        // Out of gold: the rest of the swarm stays home.
        this.remaining = 0;
        break;
      }
      // buildUnit charges the drone.
      const drone = player.buildUnit(UnitType.Drone, base.tile(), {
        targetUnit: this.target,
      });
      base.recordDroneLaunch();
      mg.addExecution(new DroneExecution(drone));
      this.remaining--;
    }
    if (this.remaining === 0) this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DroneSwarmExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      player: w.player(this.player),
      tile: this.tile,
      target: w.unitOrNull(this.target),
      lastTargetTile: this.lastTargetTile,
      remaining: this.remaining,
    });
  }

  restoreSnapshot(s: DroneSwarmState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.player = r.player(s.player);
    this.tile = s.tile;
    this.target = r.unitOrNull(s.target);
    this.lastTargetTile = s.lastTargetTile;
    this.remaining = s.remaining;
  }
}

const DroneSwarmStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  player: zPlayerRef(),
  // Validated each tick, so a pending order may hold any tile.
  tile: zInt(),
  target: zRef().nullable(),
  lastTargetTile: zInt().nullable(),
  remaining: zInt(),
});
type DroneSwarmState = z.infer<typeof DroneSwarmStateSchema>;

export const DroneSwarmExecutionSnapshot = execSnapshotType({
  name: "DroneSwarm",
  version: 1,
  schema: DroneSwarmStateSchema,
  cls: () => DroneSwarmExecution,
});

/**
 * One drone in flight: it homes on its target unit's current position every
 * tick at DRONE_SPEED tiles per tick, following ships as they move, and hits
 * once it is next to it:
 * - a flak gun is destroyed;
 * - a warship loses a third of its max health (three hits sink it);
 * - a transport ship or convoy at sea sinks with its troops.
 * If the target is destroyed or captured, it retargets the nearest valid
 * target within DRONE_RETARGET_RADIUS, or is lost; it is also lost after
 * DRONE_MAX_FLIGHT_TICKS. SAMs never fire at drones, and drones never hit SAMs;
 * flak guns and warships shoot them down.
 */
export class DroneExecution implements Execution {
  private active = true;
  private mg: Game;
  private launchTick = 0;

  constructor(private drone: Unit) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.launchTick = mg.ticks();
  }

  tick(ticks: number): void {
    const mg = this.mg;
    const drone = this.drone;
    if (!drone.isActive()) {
      // Shot down.
      this.active = false;
      return;
    }
    const owner = drone.owner();
    const target = liveTarget(
      mg,
      owner,
      drone.targetUnit() ?? null,
      drone.tile(),
    );
    if (
      target === null ||
      mg.ticks() - this.launchTick > DRONE_MAX_FLIGHT_TICKS
    ) {
      // Nothing left to hunt: lost.
      drone.delete(false);
      this.active = false;
      return;
    }
    if (target !== drone.targetUnit()) drone.setTargetUnit(target);

    let tile = drone.tile();
    const goal = target.tile();
    for (let step = 0; step < DRONE_SPEED; step++) {
      if (this.adjacent(tile, goal)) break;
      const dx = Math.sign(mg.x(goal) - mg.x(tile));
      const dy = Math.sign(mg.y(goal) - mg.y(tile));
      tile = mg.ref(mg.x(tile) + dx, mg.y(tile) + dy);
    }
    if (tile !== drone.tile()) drone.move(tile);
    if (this.adjacent(tile, goal)) this.hit(target);
  }

  /** Within one tile, diagonals included. */
  private adjacent(a: TileRef, b: TileRef): boolean {
    const mg = this.mg;
    return Math.abs(mg.x(a) - mg.x(b)) <= 1 && Math.abs(mg.y(a) - mg.y(b)) <= 1;
  }

  private hit(target: Unit): void {
    const drone = this.drone;
    const owner = drone.owner();
    const victim = target.owner();
    drone.setReachedTarget();
    drone.delete(false);
    this.active = false;
    switch (target.type()) {
      case UnitType.FlakGun:
        target.delete(true, owner);
        this.mg.displayMessage(
          "events_display.drones_destroyed_your_flak_gun",
          MessageType.UNIT_DESTROYED,
          victim.id(),
          undefined,
          { name: owner.displayName() },
          undefined,
          owner.id(),
        );
        this.mg.displayMessage(
          "events_display.drones_destroyed_flak_gun",
          MessageType.CAPTURED_ENEMY_UNIT,
          owner.id(),
          undefined,
          { name: victim.displayName() },
          undefined,
          victim.id(),
        );
        break;
      case UnitType.Warship:
        target.modifyHealth(-droneWarshipDamage(target.maxHealth()), owner);
        break;
      default:
        // A transport ship or convoy sinks with every troop aboard.
        target.delete(true, owner);
        break;
    }
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return DroneExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      drone: w.unit(this.drone),
      launchTick: this.launchTick,
    });
  }

  restoreSnapshot(s: DroneState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.drone = r.unit(s.drone);
    this.launchTick = s.launchTick;
  }
}

const DroneStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  drone: zRef(),
  launchTick: zInt(),
});
type DroneState = z.infer<typeof DroneStateSchema>;

export const DroneExecutionSnapshot = execSnapshotType({
  name: "Drone",
  version: 1,
  schema: DroneStateSchema,
  cls: () => DroneExecution,
});
