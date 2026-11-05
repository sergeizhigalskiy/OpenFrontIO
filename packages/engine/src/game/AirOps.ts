import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRBASE_STRIKE_RANGE,
  BALLISTIC_MISSILE_SILO_LEVEL,
  canDestroySam,
  CLUSTER_MISSILE_SILO_LEVEL,
  CRUISE_MISSILE_RANGE,
  DRONE_LAUNCH_INTERVAL_TICKS,
  DRONE_RANGE,
  DRONE_TARGET_PICK_RADIUS,
  DRONE_TARGET_TYPES,
  MILITARY_STRUCTURE_TYPES,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Game, Player, Unit } from "./Game";

/**
 * Targeting and launch-site rules for the conventional war flights
 * (airstrike, airdrop, cruise missile, drone). Shared by Player.canBuild and
 * the nation AI; AirMissionExecution and DroneExecution fly them.
 */

/** The player `player` may strike at `tile`: an enemy they can attack. */
function hostileOwner(
  game: Game,
  player: Player,
  tile: TileRef,
): Player | null {
  const owner = game.owner(tile);
  if (!owner.isPlayer() || owner === player) return null;
  return player.canAttackPlayer(owner) ? owner : null;
}

/**
 * The tile of `player`'s ready launcher of `type` nearest `target` within
 * `range` tiles (euclidean): active, built, and not recharging. Ties go to
 * the lowest unit id.
 */
function readyLauncherTile(
  game: Game,
  player: Player,
  type: UnitType,
  target: TileRef,
  range: number,
  ready: (unit: Unit) => boolean = (unit) => !unit.isInCooldown(),
): TileRef | false {
  const rangeSquared = range * range;
  let best: Unit | null = null;
  let bestDist = 0;
  for (const unit of player.units(type)) {
    if (!unit.isActive() || unit.isUnderConstruction() || !ready(unit)) {
      continue;
    }
    const dist = game.euclideanDistSquared(unit.tile(), target);
    if (dist > rangeSquared) continue;
    if (
      best === null ||
      dist < bestDist ||
      (dist === bestDist && unit.id() < best.id())
    ) {
      best = unit;
      bestDist = dist;
    }
  }
  return best?.tile() ?? false;
}

/** The ready airbase an airstrike or airdrop at `target` takes off from. */
export function airbaseLaunchTile(
  game: Game,
  player: Player,
  target: TileRef,
): TileRef | false {
  return readyLauncherTile(
    game,
    player,
    UnitType.Airbase,
    target,
    AIRBASE_STRIKE_RANGE,
  );
}

/** Where an airstrike at `tile` takes off, or false: it needs an enemy tile. */
export function airstrikeSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!game.isValidRef(tile) || game.isSpawnImmunityActive()) return false;
  if (hostileOwner(game, player, tile) === null) return false;
  return airbaseLaunchTile(game, player, tile);
}

/**
 * Where an airdrop at `tile` takes off, or false: it needs land that is
 * unclaimed or an enemy's, never the sender's own or a friend's.
 */
export function airdropSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!game.isValidRef(tile) || game.isSpawnImmunityActive()) return false;
  if (!game.isLand(tile) || game.isImpassable(tile)) return false;
  if (game.hasOwner(tile) && hostileOwner(game, player, tile) === null) {
    return false;
  }
  return airbaseLaunchTile(game, player, tile);
}

/**
 * The ready missile silo a cruise missile at `tile` launches from, or false:
 * it needs an enemy tile within CRUISE_MISSILE_RANGE of a silo with a loaded
 * missile. A silo fires one per loaded missile, so several silos (or one of a
 * higher level) can put a volley in the air at once.
 */
export function cruiseMissileSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (!game.isValidRef(tile) || game.isSpawnImmunityActive()) return false;
  if (hostileOwner(game, player, tile) === null) return false;
  return readyLauncherTile(
    game,
    player,
    UnitType.MissileSilo,
    tile,
    CRUISE_MISSILE_RANGE,
  );
}

/**
 * The ready missile silo of at least `minLevel` a missile at `tile` launches
 * from (the nearest, at any range, as for nukes), or false: it needs an enemy
 * tile.
 */
function heavyMissileSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
  minLevel: number,
): TileRef | false {
  if (!game.isValidRef(tile) || game.isSpawnImmunityActive()) return false;
  if (hostileOwner(game, player, tile) === null) return false;
  return readyLauncherTile(
    game,
    player,
    UnitType.MissileSilo,
    tile,
    Infinity,
    (silo) => !silo.isInCooldown() && silo.level() >= minLevel,
  );
}

/** Where a ballistic missile at `tile` launches: a silo of level 2 or more. */
export function ballisticMissileSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  return heavyMissileSpawn(game, player, tile, BALLISTIC_MISSILE_SILO_LEVEL);
}

/** Where a cluster missile at `tile` launches: a silo of level 3 or more. */
export function clusterMissileSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  return heavyMissileSpawn(game, player, tile, CLUSTER_MISSILE_SILO_LEVEL);
}

/**
 * Whether `unit` is something `player`'s drones may hit: an active enemy
 * flak gun, warship or transport ship, or an enemy convoy at sea. Never a SAM.
 */
export function isDroneTarget(game: Game, player: Player, unit: Unit): boolean {
  if (!unit.isActive() || !DRONE_TARGET_TYPES.includes(unit.type())) {
    return false;
  }
  const owner = unit.owner();
  if (owner === player || !player.canAttackPlayer(owner, true)) return false;
  if (unit.type() === UnitType.Convoy) {
    return game.isWater(unit.tile()) && unit.targetPlayer() !== player;
  }
  return true;
}

/**
 * The drone target a click at `tile` picks: the nearest valid one within
 * DRONE_TARGET_PICK_RADIUS, ties to the lowest id. Null when there is none.
 */
export function droneTargetAt(
  game: Game,
  player: Player,
  tile: TileRef,
): Unit | null {
  if (!game.isValidRef(tile)) return null;
  let best: Unit | null = null;
  let bestDist = 0;
  for (const { unit, distSquared } of game.nearbyUnits(
    tile,
    DRONE_TARGET_PICK_RADIUS,
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

/**
 * `player`'s built airbases within DRONE_RANGE of `target`, by unit id: the
 * ones a swarm at it launches from. Drones don't use the airstrike sortie.
 */
export function droneAirbases(
  game: Game,
  player: Player,
  target: TileRef,
): Unit[] {
  const rangeSquared = DRONE_RANGE * DRONE_RANGE;
  return player
    .units(UnitType.Airbase)
    .filter(
      (base) =>
        base.isActive() &&
        !base.isUnderConstruction() &&
        game.euclideanDistSquared(base.tile(), target) <= rangeSquared,
    )
    .sort((a, b) => a.id() - b.id());
}

/** Whether `airbase` may launch a drone now (one per interval). */
export function canLaunchDrone(game: Game, airbase: Unit): boolean {
  const last = airbase.lastDroneLaunchTick();
  return last === null || game.ticks() - last >= DRONE_LAUNCH_INTERVAL_TICKS;
}

/**
 * Where a drone swarm ordered at `tile` takes off, or false: there must be a
 * valid target near the click and an airbase within DRONE_RANGE of it. The
 * swarm queues behind the airbases' launch interval (DroneSwarmExecution).
 */
export function droneSpawn(
  game: Game,
  player: Player,
  tile: TileRef,
): TileRef | false {
  if (game.isSpawnImmunityActive()) return false;
  const target = droneTargetAt(game, player, tile);
  if (target === null) return false;
  return droneAirbases(game, player, target.tile())[0]?.tile() ?? false;
}

/**
 * The military structures (MILITARY_STRUCTURE_TYPES) of anyone `attacker` may
 * attack within `radius` tiles (euclidean) of `tile` that `weapon` can
 * destroy, nearest first, ties to the lowest unit id. SAMs count only when
 * canDestroySam allows.
 */
export function hostileMilitaryStructures(
  game: Game,
  attacker: Player,
  tile: TileRef,
  radius: number,
  weapon: UnitType,
): Unit[] {
  const found: { unit: Unit; distSquared: number }[] = [];
  for (const { unit, distSquared } of game.nearbyUnits(
    tile,
    radius,
    MILITARY_STRUCTURE_TYPES,
    undefined,
    true,
  )) {
    const owner = unit.owner();
    if (!unit.isActive() || owner === attacker) continue;
    if (attacker.isFriendly(owner, true)) continue;
    if (
      unit.type() === UnitType.SAMLauncher &&
      !canDestroySam(weapon, unit.level())
    ) {
      continue;
    }
    found.push({ unit, distSquared });
  }
  return found
    .sort((a, b) => a.distSquared - b.distSquared || a.unit.id() - b.unit.id())
    .map(({ unit }) => unit);
}
