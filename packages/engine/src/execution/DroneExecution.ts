import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  clampDroneSwarm,
  DRONE_BLAST_RADIUS,
  DRONE_HITS_TO_DESTROY_STRUCTURE,
  DRONE_LAUNCH_INTERVAL_TICKS,
  DRONE_MAX_FLIGHT_TICKS,
  DRONE_RETARGET_RADIUS,
  DRONE_SPEED,
  DRONE_TARGET_TYPES,
  droneStructureDamage,
  droneWarshipDamage,
} from "@openfront/engine-lib/game/ConventionalWar";
import {
  zInt,
  zPlayerRef,
  zRef,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { droneLaunchTile, droneTargetAt, isDroneTarget } from "../game/AirOps";
import { Execution, Game, Player, Unit } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { unitTypeKey } from "./AirMissionExecution";

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
 * nearest the clicked tile. No airbase: they take off one per
 * DRONE_LAUNCH_INTERVAL_TICKS from the player's land tile nearest the target
 * (droneLaunchTile), which must stay within DRONE_RANGE of it, or the order
 * ends. Each drone is paid for as it takes off; the order stops when the
 * gold runs out. If the target is destroyed or captured before the swarm is
 * out, the rest go for the nearest valid target within DRONE_RETARGET_RADIUS,
 * or the order ends.
 */
export class DroneSwarmExecution implements Execution {
  private active = true;
  private mg: Game;
  private target: Unit | null = null;
  /** Where the target was last seen, to retarget around. */
  private lastTargetTile: TileRef | null = null;
  private remaining: number;
  /** The tick the last drone took off, or null before the first. */
  private lastLaunchTick: number | null = null;

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

    if (
      this.lastLaunchTick !== null &&
      mg.ticks() - this.lastLaunchTick < DRONE_LAUNCH_INTERVAL_TICKS
    ) {
      return;
    }
    const from = droneLaunchTile(mg, player, this.target.tile());
    if (from === null) {
      // Out of range of our land (a ship sailed off, or the land was lost).
      this.active = false;
      return;
    }
    const cost = mg.unitInfo(UnitType.Drone).cost(mg, player);
    if (player.gold() < cost) {
      // Out of gold: the rest of the swarm stays home.
      this.active = false;
      return;
    }
    // buildUnit charges the drone.
    const drone = player.buildUnit(UnitType.Drone, from, {
      targetUnit: this.target,
    });
    mg.addExecution(new DroneExecution(drone));
    this.lastLaunchTick = mg.ticks();
    this.remaining--;
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
      lastLaunchTick: this.lastLaunchTick,
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
    this.lastLaunchTick = s.lastLaunchTick;
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
  /** Added in v2 (drones launched from land, one per interval). */
  lastLaunchTick: zInt().nullable(),
});
type DroneSwarmState = z.infer<typeof DroneSwarmStateSchema>;

export const DroneSwarmExecutionSnapshot = execSnapshotType({
  name: "DroneSwarm",
  version: 2,
  schema: DroneSwarmStateSchema,
  // v1 paced drones by each airbase's last launch: an old order launches
  // its next drone right away.
  migrations: {
    1: (d) => ({ ...(d as Record<string, unknown>), lastLaunchTick: null }),
  },
  cls: () => DroneSwarmExecution,
});

/**
 * One drone in flight: it homes on its target unit's current position every
 * tick at DRONE_SPEED tiles per tick, following ships as they move, and
 * detonates once it is next to it. Every valid target within
 * DRONE_BLAST_RADIUS of the target, the target included, takes one hit:
 * - a flak gun is destroyed;
 * - a warship loses a third of its max health (three hits sink it);
 * - a transport ship or convoy at sea sinks with its troops;
 * - any other structure (never a SAM) takes one of the
 *   DRONE_HITS_TO_DESTROY_STRUCTURE hits that destroy it: a third of its
 *   health if it has health, else a hit on its counter. Levels add no hits
 *   and a hit never downgrades.
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

  /**
   * Detonates at `target`: every valid drone target within DRONE_BLAST_RADIUS
   * of it (the target first, then by id) takes one hit.
   */
  private hit(target: Unit): void {
    const mg = this.mg;
    const drone = this.drone;
    const owner = drone.owner();
    drone.setReachedTarget();
    drone.delete(false);
    this.active = false;
    const others = mg
      .nearbyUnits(
        target.tile(),
        DRONE_BLAST_RADIUS,
        DRONE_TARGET_TYPES,
        undefined,
        true,
      )
      .map(({ unit }) => unit)
      .filter((unit) => unit !== target)
      .sort((a, b) => a.id() - b.id());
    for (const unit of [target, ...others]) {
      // Earlier hits may have sunk or destroyed it (a convoy's ship...).
      if (isDroneTarget(mg, owner, unit)) this.hitOne(unit, owner);
    }
  }

  /** One drone hit's effect on `target`, by its type. */
  private hitOne(target: Unit, owner: Player): void {
    switch (target.type()) {
      case UnitType.FlakGun:
        this.destroyed(target, owner);
        break;
      case UnitType.Warship:
        target.modifyHealth(-droneWarshipDamage(target.maxHealth()), owner);
        break;
      case UnitType.TransportShip:
      case UnitType.Convoy:
        // Sinks with every troop aboard.
        target.delete(true, owner);
        break;
      default:
        // A structure: a third of its health if it has health (a coastal
        // battery), else one of the hits that destroy it. Never a downgrade.
        if (target.hasHealth()) {
          const destroyed =
            target.health() <= droneStructureDamage(target.maxHealth());
          if (destroyed) {
            this.destroyed(target, owner);
          } else {
            target.modifyHealth(
              -droneStructureDamage(target.maxHealth()),
              owner,
            );
          }
        } else if (target.addDroneHit() >= DRONE_HITS_TO_DESTROY_STRUCTURE) {
          this.destroyed(target, owner);
        }
        break;
    }
  }

  /** Destroys a structure the drones hit and tells both sides. */
  private destroyed(target: Unit, owner: Player): void {
    const victim = target.owner();
    target.delete(true, owner);
    if (target.type() === UnitType.FlakGun) {
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
      return;
    }
    const unit = unitTypeKey(target.type());
    this.mg.displayMessage(
      "events_display.air_destroyed_your_structure",
      MessageType.UNIT_DESTROYED,
      victim.id(),
      undefined,
      { unit, name: owner.displayName() },
      undefined,
      owner.id(),
    );
    this.mg.displayMessage(
      "events_display.air_destroyed_structure",
      MessageType.CAPTURED_ENEMY_UNIT,
      owner.id(),
      undefined,
      { unit, name: victim.displayName() },
      undefined,
      victim.id(),
    );
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
