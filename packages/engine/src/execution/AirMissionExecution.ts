import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  AIRSTRIKE_FRONT_RADIUS,
  AIRSTRIKE_STRUCTURE_RADIUS,
  airdropTroops,
  airstrikeFrontKills,
  airstrikeTroopKills,
  BALLISTIC_MISSILE_BLAST_RADIUS,
  BALLISTIC_MISSILE_SPEED,
  ballisticTroopKills,
  CLUSTER_MISSILE_SPEED,
  CLUSTER_SEPARATION_DISTANCE,
  CLUSTER_SPREAD_RADIUS,
  CLUSTER_WARHEAD_COUNT,
  CLUSTER_WARHEAD_SPEED,
  CRUISE_MISSILE_BLAST_RADIUS,
  CRUISE_MISSILE_SPEED,
  MILITARY_STRUCTURE_TYPES,
  PLANE_SPEED,
} from "@openfront/engine-lib/game/ConventionalWar";
import {
  zNum,
  zPlayerRef,
  zRef,
  zTile,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { hostileMilitaryStructures } from "../game/AirOps";
import { Attack, Execution, Game, isUnit, Player, Unit } from "../game/Game";
import { UniversalPathFinding } from "../pathfinding/PathFinder";
import { ParabolaUniversalPathFinder } from "../pathfinding/PathFinder.Parabola";
import { PathStatus } from "../pathfinding/types";
import { UnitTypeSchema } from "../snapshot/CommonSchemas";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import {
  ParabolaSchema,
  parabolaState,
  restoreParabola,
} from "../snapshot/PathfinderSnapshots";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { AttackExecution } from "./AttackExecution";

/** The conventional war flights this execution flies. */
export type AirMissionType =
  | UnitType.Airstrike
  | UnitType.Airdrop
  | UnitType.CruiseMissile
  | UnitType.BallisticMissile
  | UnitType.ClusterMissile
  | UnitType.ClusterWarhead;

const AIR_MISSION_TYPES: readonly UnitType[] = [
  UnitType.Airstrike,
  UnitType.Airdrop,
  UnitType.CruiseMissile,
  UnitType.BallisticMissile,
  UnitType.ClusterMissile,
  UnitType.ClusterWarhead,
];

export function isAirMissionType(type: UnitType): type is AirMissionType {
  return AIR_MISSION_TYPES.includes(type);
}

/** The translation key naming a unit type in strike messages. */
export function unitTypeKey(type: UnitType): string {
  return `unit_type.${type.toLowerCase().replace(/ /g, "_")}`;
}

/** True when some tile of `attack`'s front is within `radius` of `tile`. */
function frontNear(
  game: Game,
  attack: Attack,
  tile: TileRef,
  radius: number,
): boolean {
  const radiusSquared = radius * radius;
  for (const t of attack.borderTiles()) {
    if (game.euclideanDistSquared(t, tile) <= radiusSquared) return true;
  }
  return false;
}

/**
 * One conventional war flight, from takeoff to impact (rules and numbers in
 * engine-lib/game/ConventionalWar.ts):
 *
 * - Airstrike: a plane from a ready airbase within AIRBASE_STRIKE_RANGE. It
 *   destroys every hostile military structure within
 *   AIRSTRIKE_STRUCTURE_RADIUS of the target, kills a capped share of the
 *   target owner's troops, and a capped share of their attacks whose front is
 *   within AIRSTRIKE_FRONT_RADIUS.
 * - Airdrop: a transport plane from a ready airbase carrying troops. It lands
 *   on the clicked tile and attacks outward from it, like a boat landing.
 * - Cruise missile: from a silo within CRUISE_MISSILE_RANGE; it destroys
 *   every hostile military structure within CRUISE_MISSILE_BLAST_RADIUS.
 * - Ballistic missile: from a level 2+ silo; it destroys every structure
 *   within BALLISTIC_MISSILE_BLAST_RADIUS, whoever owns it, and kills a share
 *   of the troops of everyone with land there (the launcher and its allies
 *   too), and of their attacks fighting there.
 * - Cluster missile: from a level 3+ silo, a carrier that splits
 *   CLUSTER_SEPARATION_DISTANCE short of the target into
 *   CLUSTER_WARHEAD_COUNT cluster warheads, each aimed at its own hostile
 *   structure within CLUSTER_SPREAD_RADIUS (military first). A warhead
 *   destroys its structure and every military structure within
 *   CRUISE_MISSILE_BLAST_RADIUS, whoever owns them.
 *
 * Airstrikes and cruise missiles only ever hurt enemies; ballistic missiles
 * and cluster warheads hit friends and the launcher too (friendly fire).
 *
 * None takes land or leaves fallout. All fly a low flat line (the parabola
 * path finder with no height) and carry a nuke-style trajectory, so SAMs
 * pre-aim and shoot them down exactly as they do nukes, one missile each
 * (SAMLauncherExecution); the cluster carrier, like a MIRV's, can't be shot
 * down. Flak guns fire at the planes (FlakGunExecution). A flight shot down
 * does nothing; an airdrop's troops are lost with it.
 */
export class AirMissionExecution implements Execution {
  private active = true;
  private mg: Game;
  private pathFinder: ParabolaUniversalPathFinder;
  private flight: Unit | null = null;

  constructor(
    private type: AirMissionType,
    private player: Player,
    private dst: TileRef,
    /**
     * Airdrops only: the troops asked for (the sender's attack-ratio share).
     * Null takes the default attack amount. Capped at takeoff.
     */
    private requestedTroops: number | null = null,
    /**
     * Where the flight starts. Set at takeoff from the launching airbase or
     * silo; given up front for cluster warheads (the split point).
     */
    private src: TileRef | null = null,
    /** Cluster warheads only: the structure this warhead is aimed at. */
    private targetStructure: Unit | null = null,
  ) {}

  private speed(): number {
    switch (this.type) {
      case UnitType.Airstrike:
      case UnitType.Airdrop:
        return PLANE_SPEED;
      case UnitType.CruiseMissile:
        return CRUISE_MISSILE_SPEED;
      case UnitType.BallisticMissile:
        return BALLISTIC_MISSILE_SPEED;
      case UnitType.ClusterMissile:
        return CLUSTER_MISSILE_SPEED;
      case UnitType.ClusterWarhead:
        return CLUSTER_WARHEAD_SPEED;
    }
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    this.pathFinder = UniversalPathFinding.Parabola(mg, {
      increment: this.speed(),
      distanceBasedHeight: false,
    });
  }

  tick(ticks: number): void {
    if (this.flight === null) {
      this.takeOff();
      return;
    }
    // Shot down by a SAM or a flak gun: it does nothing.
    if (!this.flight.isActive()) {
      this.active = false;
      return;
    }

    const result = this.pathFinder.next(this.src!, this.dst, this.speed());
    if (result.status === PathStatus.COMPLETE) {
      this.flight.move(this.dst);
      if (this.type === UnitType.ClusterMissile) {
        this.split();
        return;
      }
      // As for nukes: a SAM missile about to hit it has the last word.
      if (this.samMissileClosingIn()) return;
      this.arrive();
    } else if (result.status === PathStatus.NEXT) {
      this.flight.move(result.node);
      // SAMs read this to aim ahead.
      this.flight.setTrajectoryIndex(this.pathFinder.currentIndex());
      this.updateTargetable();
      if (
        this.type === UnitType.ClusterMissile &&
        this.mg.euclideanDistSquared(result.node, this.dst) <=
          CLUSTER_SEPARATION_DISTANCE * CLUSTER_SEPARATION_DISTANCE
      ) {
        this.split();
      }
    }
  }

  private takeOff(): void {
    const player = this.player;
    if (this.type === UnitType.ClusterWarhead) {
      // Split off a carrier: no launcher, no price.
      this.flight = player.buildUnit(UnitType.ClusterWarhead, this.src!, {
        targetTile: this.dst,
        trajectory: this.pathFinder.findPath(this.src!, this.dst) ?? [],
      });
      return;
    }

    const spawn = player.canBuild(this.type, this.dst);
    if (spawn === false) {
      console.warn(`${player.name()} cannot fly ${this.type} at ${this.dst}`);
      this.active = false;
      return;
    }
    const isPlane =
      this.type === UnitType.Airstrike || this.type === UnitType.Airdrop;
    const launcher = player
      .units(isPlane ? UnitType.Airbase : UnitType.MissileSilo)
      .find((unit) => unit.tile() === spawn);
    this.src = spawn;
    const trajectory = this.pathFinder.findPath(spawn, this.dst) ?? [];
    const targetTile = this.dst;

    if (this.type === UnitType.Airdrop) {
      const config = this.mg.config();
      const requested =
        this.requestedTroops ??
        config.attackAmount(player, this.mg.owner(this.dst));
      const troops = airdropTroops(
        requested,
        player.troops(),
        config.maxTroops(player),
      );
      if (troops < 1) {
        this.active = false;
        return;
      }
      // buildUnit takes the troops aboard from the player.
      this.flight = player.buildUnit(UnitType.Airdrop, spawn, {
        targetTile,
        trajectory,
        troops,
      });
    } else {
      this.flight = player.buildUnit(this.type, spawn, {
        targetTile,
        trajectory,
      });
    }
    // Spends the airbase's sortie, or one of the silo's missiles.
    launcher?.launch();

    if (this.type === UnitType.ClusterMissile) {
      // Raises the next one's price.
      this.mg.recordClusterMissileLaunch();
    }
    if (
      this.type === UnitType.BallisticMissile ||
      this.type === UnitType.ClusterMissile
    ) {
      const target = this.mg.owner(this.dst);
      if (target.isPlayer()) {
        this.mg.displayIncomingUnit(
          this.flight.id(),
          this.type === UnitType.BallisticMissile
            ? "events_display.ballistic_missile_inbound"
            : "events_display.cluster_missile_inbound",
          MessageType.HYDROGEN_BOMB_INBOUND,
          target.id(),
        );
      }
    }
  }

  /** True when an enemy SAM missile aimed at this flight is about to hit. */
  private samMissileClosingIn(): boolean {
    const flight = this.flight!;
    return this.mg
      .nearbyUnits(
        this.dst,
        this.mg.config().defaultSamMissileSpeed(),
        UnitType.SAMMissile,
        ({ unit }) =>
          isUnit(unit) &&
          unit.owner() !== flight.owner() &&
          unit.targetUnit()?.id() === flight.id(),
      )
      .some(() => true);
  }

  /** SAMs only engage a flight near its ends, as for nukes. */
  private updateTargetable(): void {
    const flight = this.flight!;
    const range = this.mg.config().defaultNukeTargetableRange();
    const rangeSquared = range * range;
    flight.setTargetable(
      this.mg.euclideanDistSquared(flight.tile(), this.dst) < rangeSquared ||
        this.mg.euclideanDistSquared(this.src!, flight.tile()) < rangeSquared,
    );
  }

  private arrive(): void {
    const flight = this.flight!;
    flight.setReachedTarget();
    switch (this.type) {
      case UnitType.Airstrike:
        this.destroyStructures(AIRSTRIKE_STRUCTURE_RADIUS);
        this.killTroops();
        break;
      case UnitType.Airdrop:
        this.land(flight.troops());
        break;
      case UnitType.CruiseMissile:
      case UnitType.ClusterWarhead:
        if (this.destroyStructures(CRUISE_MISSILE_BLAST_RADIUS) === 0) {
          this.mg.displayMessage(
            "events_display.missile_hit_nothing",
            MessageType.ATTACK_FAILED,
            this.player.id(),
            undefined,
            { unit: unitTypeKey(this.type) },
          );
        }
        break;
      case UnitType.BallisticMissile:
        this.ballisticImpact();
        break;
      case UnitType.ClusterMissile:
        break;
    }
    flight.delete(false);
    this.active = false;
  }

  /**
   * Destroys every military structure within `radius` of the impact that
   * this weapon can destroy, and a cluster warhead's own structure (whatever
   * its type) if it is still there. Airstrikes and cruise missiles spare the
   * attacker's and its friends' structures; a cluster warhead doesn't
   * (friendly fire). Returns how many.
   */
  private destroyStructures(radius: number): number {
    const friendlyFire = this.type === UnitType.ClusterWarhead;
    const structures = hostileMilitaryStructures(
      this.mg,
      this.player,
      this.dst,
      radius,
      this.type,
      friendlyFire,
    );
    const own = this.targetStructure;
    if (
      own !== null &&
      own.isActive() &&
      (friendlyFire || this.isEnemy(own.owner())) &&
      !structures.includes(own)
    ) {
      structures.unshift(own);
    }
    for (const structure of structures) this.destroyStructure(structure);
    return structures.length;
  }

  private destroyStructure(structure: Unit): void {
    const victim = structure.owner();
    const unit = unitTypeKey(structure.type());
    // As for nukes: friendly fire credits nobody with the kill.
    structure.delete(true, this.isEnemy(victim) ? this.player : undefined);
    // Our own structure: nobody to report it to.
    if (victim === this.player) return;
    this.mg.displayMessage(
      "events_display.air_destroyed_structure",
      MessageType.CAPTURED_ENEMY_UNIT,
      this.player.id(),
      undefined,
      { unit, name: victim.displayName() },
      undefined,
      victim.id(),
    );
    this.mg.displayMessage(
      "events_display.air_destroyed_your_structure",
      MessageType.UNIT_DESTROYED,
      victim.id(),
      undefined,
      { unit, name: this.player.displayName() },
      undefined,
      this.player.id(),
    );
  }

  /** Whether the attacker may hurt `other` (an enemy, not a friend). */
  private isEnemy(other: Player): boolean {
    return other !== this.player && !this.player.isFriendly(other, true);
  }

  /** The airstrike's troop kills on the target tile's owner. */
  private killTroops(): void {
    // The target tile's owner at impact: it may have changed during the flight.
    const target = this.mg.owner(this.dst);
    if (!target.isPlayer() || !this.isEnemy(target)) return;
    let killed = target.removeTroops(airstrikeTroopKills(target.troops()));
    const attacks = target
      .outgoingAttacks()
      .filter(
        (attack) =>
          attack.isActive() &&
          frontNear(this.mg, attack, this.dst, AIRSTRIKE_FRONT_RADIUS),
      );
    const kills = airstrikeFrontKills(attacks.map((attack) => attack.troops()));
    attacks.forEach((attack, i) => {
      attack.setTroops(attack.troops() - kills[i]);
      killed += kills[i];
    });

    const troops = renderTroops(killed);
    this.mg.displayMessage(
      "events_display.airstrike_hit",
      MessageType.CAPTURED_ENEMY_UNIT,
      this.player.id(),
      undefined,
      { troops, name: target.displayName() },
      undefined,
      target.id(),
    );
    this.mg.displayMessage(
      "events_display.airstrike_hit_you",
      MessageType.UNIT_DESTROYED,
      target.id(),
      undefined,
      { troops, name: this.player.displayName() },
      undefined,
      this.player.id(),
    );
  }

  /**
   * Every structure within the blast is destroyed, whoever owns it (friendly
   * fire: the launcher's own and its allies' too), and each player owning
   * land in it, the launcher and its allies included, loses a share of their
   * troops and of the troops in their attacks fighting in it. Land and
   * fallout are untouched.
   */
  private ballisticImpact(): void {
    const mg = this.mg;
    const radius = BALLISTIC_MISSILE_BLAST_RADIUS;
    const radiusSquared = radius * radius;

    let destroyed = 0;
    const structures = mg
      .nearbyUnits(this.dst, radius, Structures.types, undefined, true)
      .map(({ unit }) => unit)
      .filter((unit) => unit.isActive())
      .sort((a, b) => a.id() - b.id());
    for (const structure of structures) {
      // As for nukes: friendly fire credits nobody with the kill.
      structure.delete(
        true,
        this.isEnemy(structure.owner()) ? this.player : undefined,
      );
      destroyed++;
    }

    // Everyone with land in the blast, by smallID.
    const owners = new Map<number, Player>();
    const cx = mg.x(this.dst);
    const cy = mg.y(this.dst);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radiusSquared) continue;
        if (!mg.isValidCoord(cx + dx, cy + dy)) continue;
        const owner = mg.owner(mg.ref(cx + dx, cy + dy));
        if (owner.isPlayer()) owners.set(owner.smallID(), owner);
      }
    }
    let killedTotal = 0;
    for (const [, victim] of [...owners].sort((a, b) => a[0] - b[0])) {
      let killed = victim.removeTroops(ballisticTroopKills(victim.troops()));
      for (const attack of victim.outgoingAttacks()) {
        if (!attack.isActive() || !frontNear(mg, attack, this.dst, radius)) {
          continue;
        }
        const kill = ballisticTroopKills(attack.troops());
        attack.setTroops(attack.troops() - kill);
        killed += kill;
      }
      killedTotal += killed;
      // Our own losses are in the launcher's summary below.
      if (victim === this.player) continue;
      mg.displayMessage(
        "events_display.ballistic_missile_hit_you",
        MessageType.NUKE_DETONATED,
        victim.id(),
        undefined,
        { name: this.player.displayName(), troops: renderTroops(killed) },
        undefined,
        this.player.id(),
      );
    }
    mg.displayMessage(
      "events_display.ballistic_missile_hit",
      MessageType.CAPTURED_ENEMY_UNIT,
      this.player.id(),
      undefined,
      { count: destroyed, troops: renderTroops(killedTotal) },
    );
  }

  /**
   * The carrier splits into CLUSTER_WARHEAD_COUNT warheads, each aimed at its
   * own hostile structure within CLUSTER_SPREAD_RADIUS of the target:
   * military ones first, then nearest the target, then lowest id. With fewer
   * structures than warheads, the spare warheads double up on them in that
   * order; with none, they all fall on the target tile.
   */
  private split(): void {
    const mg = this.mg;
    const carrier = this.flight!;
    const from = carrier.tile();
    const picks = mg
      .nearbyUnits(
        this.dst,
        CLUSTER_SPREAD_RADIUS,
        Structures.types,
        undefined,
        true,
      )
      .filter(({ unit }) => this.isEnemy(unit.owner()))
      .map(({ unit, distSquared }) => ({
        unit,
        distSquared,
        military: MILITARY_STRUCTURE_TYPES.includes(unit.type()) ? 0 : 1,
      }))
      .sort(
        (a, b) =>
          a.military - b.military ||
          a.distSquared - b.distSquared ||
          a.unit.id() - b.unit.id(),
      )
      .map(({ unit }) => unit);
    for (let i = 0; i < CLUSTER_WARHEAD_COUNT; i++) {
      const target = picks.length > 0 ? picks[i % picks.length] : null;
      mg.addExecution(
        new AirMissionExecution(
          UnitType.ClusterWarhead,
          this.player,
          target?.tile() ?? this.dst,
          null,
          from,
          target,
        ),
      );
    }
    carrier.setReachedTarget();
    carrier.delete(false);
    this.active = false;
  }

  /** Paratroopers land and attack outward from the tile, like a beachhead. */
  private land(troops: number): void {
    const player = this.player;
    const target = this.mg.owner(this.dst);
    // The tile became ours or a friend's during the flight: troops go home.
    if (target === player || (target.isPlayer() && !this.isEnemy(target))) {
      player.addTroops(troops);
      return;
    }
    player.conquer(this.dst);
    this.mg.addExecution(
      new AttackExecution(troops, player, target.id(), this.dst, false),
    );
    const rendered = renderTroops(troops);
    this.mg.displayMessage(
      "events_display.airdrop_landed",
      MessageType.CAPTURED_ENEMY_UNIT,
      player.id(),
      undefined,
      { troops: rendered },
    );
    if (target.isPlayer()) {
      this.mg.displayMessage(
        "events_display.airdrop_landed_on_you",
        MessageType.NAVAL_INVASION_INBOUND,
        target.id(),
        undefined,
        { troops: rendered, name: player.displayName() },
        undefined,
        player.id(),
      );
    }
  }

  cancel(): void {
    this.active = false;
    if (this.flight !== null && this.flight.isActive()) {
      this.flight.delete(false);
    }
  }

  owner(): Player {
    return this.player;
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return AirMissionExecutionSnapshot.write({
      active: this.active,
      type: this.type,
      player: w.player(this.player),
      dst: this.dst,
      requestedTroops: this.requestedTroops,
      // mg and the path finder are both set by init.
      pathFinder: this.mg === undefined ? null : parabolaState(this.pathFinder),
      flight: w.unitOrNull(this.flight),
      src: this.src,
      targetStructure: w.unitOrNull(this.targetStructure),
    });
  }

  restoreSnapshot(s: AirMissionState, r: SnapshotReader): void {
    this.active = s.active;
    this.type = s.type as AirMissionType;
    this.player = r.player(s.player);
    this.dst = s.dst;
    this.requestedTroops = s.requestedTroops;
    if (s.pathFinder !== null) {
      this.mg = r.game;
      this.pathFinder = restoreParabola(r.game, s.pathFinder);
    }
    this.flight = r.unitOrNull(s.flight);
    this.src = s.src;
    this.targetStructure = r.unitOrNull(s.targetStructure);
  }
}

const AirMissionStateSchema = z.object({
  active: z.boolean(),
  type: UnitTypeSchema,
  player: zPlayerRef(),
  // Validated at takeoff, so a pending order may hold any tile.
  dst: z.number().int(),
  requestedTroops: zNum().nullable(),
  pathFinder: ParabolaSchema.nullable(),
  flight: zRef().nullable(),
  src: zTile().nullable(),
  targetStructure: zRef().nullable(),
});
type AirMissionState = z.infer<typeof AirMissionStateSchema>;

export const AirMissionExecutionSnapshot = execSnapshotType({
  name: "AirMission",
  version: 1,
  schema: AirMissionStateSchema,
  cls: () => AirMissionExecution,
});
