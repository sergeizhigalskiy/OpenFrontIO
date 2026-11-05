import { TileRef } from "@openfront/engine-api/game/GameMap";
import { LaunchBlock, UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRBASE_STRIKE_RANGE,
  BALLISTIC_MISSILE_SILO_LEVEL,
  canDestroySam,
  CLUSTER_MISSILE_SILO_LEVEL,
  CRUISE_MISSILE_RANGE,
  DRONE_RANGE,
  DRONE_TARGET_PICK_RADIUS,
  DRONE_TARGET_TYPES,
  MILITARY_STRUCTURE_TYPES,
  STRIKE_TARGET_TYPES,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Game, Player, Unit } from "./Game";

/**
 * Targeting and launch-site rules for the conventional war orders (airstrike,
 * airdrop, cruise, ballistic and cluster missiles, drones). airLaunch is the
 * one place that decides whether an order can go and, when not, why: shared
 * by Player.canBuild, the build menu's reason (BuildableUnit.blocked) and the
 * nation AI. AirMissionExecution and DroneExecution fly them.
 */

/** The air orders a player gives, which airLaunch decides. */
export type AirOrderType =
  | UnitType.Airstrike
  | UnitType.Airdrop
  | UnitType.CruiseMissile
  | UnitType.BallisticMissile
  | UnitType.ClusterMissile
  | UnitType.Drone;

export function isAirOrderType(type: UnitType): type is AirOrderType {
  switch (type) {
    case UnitType.Airstrike:
    case UnitType.Airdrop:
    case UnitType.CruiseMissile:
    case UnitType.BallisticMissile:
    case UnitType.ClusterMissile:
    case UnitType.Drone:
      return true;
    default:
      return false;
  }
}

/** The tile an airLaunch answer takes off from, or false when blocked. */
export function launchTile(launch: TileRef | LaunchBlock): TileRef | false {
  return typeof launch === "number" ? launch : false;
}

/**
 * Where `player`'s air order of `type` at `tile` takes off, or why it can't.
 * Gold is not checked here: Player.canBuild checks it first. The target is
 * checked before the launcher, so a wrong target is what gets reported.
 *
 * - Airstrike: any tile (land or water, anyone's), and a ready airbase
 *   within AIRBASE_STRIKE_RANGE of it.
 * - Airdrop: enemy or unclaimed land, and the same airbase.
 * - Cruise missile: any tile, and a silo with a loaded missile within
 *   CRUISE_MISSILE_RANGE of it.
 * - Ballistic and cluster missiles: an enemy tile, and a ready silo of
 *   BALLISTIC_MISSILE_SILO_LEVEL or CLUSTER_MISSILE_SILO_LEVEL, at any range.
 * - Drones: a valid target near the tile (droneTargetAt), within DRONE_RANGE
 *   of the player's own land (droneLaunchTile). No airbase.
 */
export function airLaunch(
  game: Game,
  player: Player,
  type: AirOrderType,
  tile: TileRef,
): TileRef | LaunchBlock {
  if (game.isSpawnImmunityActive()) return "spawn_protection";
  switch (type) {
    case UnitType.Airstrike:
      // Any tile in range, as for nukes: the blast picks what it destroys.
      if (!game.isValidRef(tile)) return "no_airbase";
      return airbaseLaunch(game, player, tile);
    case UnitType.Airdrop:
      return (
        airdropTileBlock(game, player, tile) ??
        airbaseLaunch(game, player, tile)
      );
    case UnitType.CruiseMissile:
      if (!game.isValidRef(tile)) return "no_loaded_silo";
      return cruiseLaunch(game, player, tile);
    case UnitType.BallisticMissile:
      return (
        enemyTileBlock(game, player, tile) ??
        heavyLaunch(game, player, tile, BALLISTIC_MISSILE_SILO_LEVEL)
      );
    case UnitType.ClusterMissile:
      return (
        enemyTileBlock(game, player, tile) ??
        heavyLaunch(game, player, tile, CLUSTER_MISSILE_SILO_LEVEL)
      );
    case UnitType.Drone: {
      const target = droneTargetAt(game, player, tile);
      if (target === null) return "no_drone_target";
      return droneLaunchTile(game, player, target.tile()) ?? "drone_range";
    }
  }
}

/**
 * Why `player` can't launch an order of `type` at any tile right now, or
 * null: airLaunch's rules that hold whatever the target (spawn protection
 * and the launcher), for the build bar, which asks without a tile. Gold is
 * the caller's, as for airLaunch.
 */
export function airLaunchBlockAnywhere(
  game: Game,
  player: Player,
  type: AirOrderType,
): LaunchBlock | null {
  if (game.isSpawnImmunityActive()) return "spawn_protection";
  let launch: TileRef | LaunchBlock;
  switch (type) {
    case UnitType.Airstrike:
    case UnitType.Airdrop:
      launch = airbaseLaunch(game, player, null);
      break;
    case UnitType.CruiseMissile:
      launch = cruiseLaunch(game, player, null);
      break;
    case UnitType.BallisticMissile:
      launch = heavyLaunch(game, player, null, BALLISTIC_MISSILE_SILO_LEVEL);
      break;
    case UnitType.ClusterMissile:
      launch = heavyLaunch(game, player, null, CLUSTER_MISSILE_SILO_LEVEL);
      break;
    case UnitType.Drone:
      // Any land of the player's will do: only the target can stop it.
      return null;
  }
  return typeof launch === "string" ? launch : null;
}

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

/** "enemy_land" unless `tile` is an enemy's, or null. */
function enemyTileBlock(
  game: Game,
  player: Player,
  tile: TileRef,
): LaunchBlock | null {
  if (!game.isValidRef(tile) || hostileOwner(game, player, tile) === null) {
    return "enemy_land";
  }
  return null;
}

/**
 * "airdrop_land" unless `tile` is land that is unclaimed or an enemy's,
 * never the sender's own or a friend's, or null.
 */
function airdropTileBlock(
  game: Game,
  player: Player,
  tile: TileRef,
): LaunchBlock | null {
  if (!game.isValidRef(tile) || !game.isLand(tile) || game.isImpassable(tile)) {
    return "airdrop_land";
  }
  if (game.hasOwner(tile) && hostileOwner(game, player, tile) === null) {
    return "airdrop_land";
  }
  return null;
}

/**
 * `player`'s ready launcher of `type` (level `minLevel` or more) nearest
 * `target` within `range` tiles (euclidean): active, built and not in
 * cooldown. Ties go to the lowest unit id; with no target, the lowest id
 * anywhere. When there is none, why: "reloading" when one in range is built
 * but in cooldown, else "building" when one in range is being built, else
 * "none".
 */
function readyLauncher(
  game: Game,
  player: Player,
  type: UnitType,
  target: TileRef | null,
  range: number,
  minLevel = 1,
): Unit | "none" | "building" | "reloading" {
  const rangeSquared = range * range;
  let best: Unit | null = null;
  let bestDist = 0;
  let building = false;
  let reloading = false;
  for (const unit of player.units(type)) {
    if (!unit.isActive() || unit.level() < minLevel) continue;
    const d =
      target === null ? 0 : game.euclideanDistSquared(unit.tile(), target);
    if (d > rangeSquared) continue;
    if (unit.isUnderConstruction()) {
      building = true;
      continue;
    }
    if (unit.isInCooldown()) {
      reloading = true;
      continue;
    }
    if (
      best === null ||
      d < bestDist ||
      (d === bestDist && unit.id() < best.id())
    ) {
      best = unit;
      bestDist = d;
    }
  }
  if (best !== null) return best;
  return reloading ? "reloading" : building ? "building" : "none";
}

/** The ready airbase an airstrike or airdrop at `target` takes off from. */
function airbaseLaunch(
  game: Game,
  player: Player,
  target: TileRef | null,
): TileRef | LaunchBlock {
  const base = readyLauncher(
    game,
    player,
    UnitType.Airbase,
    target,
    AIRBASE_STRIKE_RANGE,
  );
  switch (base) {
    case "none":
      return "no_airbase";
    case "building":
      return "airbase_building";
    case "reloading":
      return "airbase_recharging";
    default:
      return base.tile();
  }
}

/**
 * The ready missile silo a cruise missile at `target` launches from: one
 * with a loaded missile within CRUISE_MISSILE_RANGE. A silo fires one per
 * loaded missile, so several silos (or one of a higher level) can put a
 * volley in the air at once.
 */
function cruiseLaunch(
  game: Game,
  player: Player,
  target: TileRef | null,
): TileRef | LaunchBlock {
  const silo = readyLauncher(
    game,
    player,
    UnitType.MissileSilo,
    target,
    CRUISE_MISSILE_RANGE,
  );
  return typeof silo === "string" ? "no_loaded_silo" : silo.tile();
}

/**
 * The ready missile silo of at least `minLevel` a ballistic or cluster
 * missile at `target` launches from: the nearest, at any range, as for
 * nukes.
 */
function heavyLaunch(
  game: Game,
  player: Player,
  target: TileRef | null,
  minLevel: number,
): TileRef | LaunchBlock {
  const silo = readyLauncher(
    game,
    player,
    UnitType.MissileSilo,
    target,
    Infinity,
    minLevel,
  );
  if (silo === "reloading") return "silo_reloading";
  if (typeof silo === "string") {
    return minLevel >= CLUSTER_MISSILE_SILO_LEVEL
      ? "silo_level_3"
      : "silo_level_2";
  }
  return silo.tile();
}

/**
 * Whether `unit` is something `player`'s drones may hit: an active enemy
 * structure other than a SAM, warship or transport ship, or an enemy convoy
 * at sea (DRONE_TARGET_TYPES). Never a SAM or a minefield.
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
 * The tile a drone at `target` takes off from: `player`'s land tile nearest
 * it (euclidean), ties to the lowest TileRef, when that is within
 * DRONE_RANGE; else null. Drones need no airbase. Only border tiles are
 * scanned: for a target off the player's land the nearest own tile is
 * always a border tile (a step from an inner tile toward the target lands
 * on another own tile, closer), so this stays cheap enough for the build
 * preview, which asks on every hover.
 */
export function droneLaunchTile(
  game: Game,
  player: Player,
  target: TileRef,
): TileRef | null {
  if (game.owner(target) === player && game.isLand(target)) return target;
  const tx = game.x(target);
  const ty = game.y(target);
  const rangeSquared = DRONE_RANGE * DRONE_RANGE;
  let best: TileRef | null = null;
  let bestDist = 0;
  for (const tile of player.borderTiles()) {
    const dx = game.x(tile) - tx;
    const dy = game.y(tile) - ty;
    const dist = dx * dx + dy * dy;
    if (dist > rangeSquared || !game.isLand(tile)) continue;
    if (
      best === null ||
      dist < bestDist ||
      (dist === bestDist && tile < best)
    ) {
      best = tile;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * What an airstrike or a cruise missile (`weapon`) landing on `tile`
 * destroys: every unit of STRIKE_TARGET_TYPES within `radius` tiles
 * (euclidean) owned by a player `attacker` can attack (never its own or a
 * friend's, even AFK), SAMs only as canDestroySam allows. Nearest first,
 * ties to the lowest unit id.
 */
export function strikeTargets(
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
    STRIKE_TARGET_TYPES,
    undefined,
    true,
  )) {
    if (!unit.isActive()) continue;
    const owner = unit.owner();
    if (owner === attacker || !attacker.canAttackPlayer(owner, true)) continue;
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

/**
 * The military structures (MILITARY_STRUCTURE_TYPES) of anyone `attacker` may
 * attack within `radius` tiles (euclidean) of `tile` that `weapon` can
 * destroy, nearest first, ties to the lowest unit id. SAMs count only when
 * canDestroySam allows. With `friendlyFire`, the attacker's own and its
 * friends' structures count too.
 */
export function hostileMilitaryStructures(
  game: Game,
  attacker: Player,
  tile: TileRef,
  radius: number,
  weapon: UnitType,
  friendlyFire = false,
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
    if (!unit.isActive()) continue;
    if (
      !friendlyFire &&
      (owner === attacker || attacker.isFriendly(owner, true))
    ) {
      continue;
    }
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
