import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  Structures,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  AIRSTRIKE_STRUCTURE_RADIUS,
  BALLISTIC_MISSILE_BLAST_RADIUS,
  CRUISE_MISSILE_BLAST_RADIUS,
  CRUISE_MISSILE_RANGE,
  DRONE_HITS_TO_DESTROY_STRUCTURE,
  DRONE_SWARM_MAX,
  droneStructureDamage,
  droneWarshipDamage,
  FLAK_GUN_RANGE,
  FLAK_ROUNDS,
} from "@openfront/engine-lib/game/ConventionalWar";
import { droneAirbases, droneTargetAt, isDroneTarget } from "../../game/AirOps";
import { Game, Player, Unit } from "../../game/Game";
import { UniversalPathFinding } from "../../pathfinding/PathFinder";
import { AirMissionExecution } from "../AirMissionExecution";
import { DroneSwarmExecution } from "../DroneExecution";
import { findEnemySamsCoveringTile } from "./NationNukePlanning";

/**
 * Conventional war planning shared by the nation behaviors that fly air
 * units (the counterpart of NationNukePlanning for nukes). Nothing here
 * draws from a PRNG or keeps state.
 *
 * Everything a nation orders goes through the same executions, costs,
 * cooldowns and ranges as a human's (canBuild, AirMissionExecution,
 * DroneSwarmExecution): these only decide what to order.
 */

/** Gold a nation keeps in hand after any air spend, keyed by difficulty. */
const AIR_RESERVE_GOLD: Record<Difficulty, bigint> = {
  [Difficulty.Easy]: 2_000_000n,
  [Difficulty.Medium]: 1_500_000n,
  [Difficulty.Hard]: 1_000_000n,
  [Difficulty.Impossible]: 500_000n,
};

/** The gold `player` can spend on air units now, past the reserve. */
export function spareAirGold(game: Game, player: Player): bigint {
  const { difficulty } = game.config().gameConfig();
  return player.gold() - AIR_RESERVE_GOLD[difficulty];
}

/** The price of `count` units of `type` for `player`. */
export function priceOf(
  game: Game,
  player: Player,
  type: UnitType,
  count = 1,
): bigint {
  return game.unitInfo(type).cost(game, player) * BigInt(count);
}

/** Hostile SAMs whose range covers `tile`, lowest level first, then id. */
export function hostileSamsCovering(
  game: Game,
  player: Player,
  tile: TileRef,
): Unit[] {
  return findEnemySamsCoveringTile(game, player, tile).sort(
    (a, b) => a.level() - b.level() || a.id() - b.id(),
  );
}

/**
 * Cruise missiles a volley at `tile` needs to get one through: every
 * covering SAM shoots one down per loaded missile, so the sum of their
 * levels plus one. A lone missile at a loaded level-1 SAM is wasted.
 */
export function cruiseVolleySize(
  game: Game,
  player: Player,
  tile: TileRef,
): number {
  let levels = 0;
  for (const sam of findEnemySamsCoveringTile(game, player, tile)) {
    levels += sam.level();
  }
  return levels + 1;
}

/**
 * Cruise missiles `player`'s silos can fire at `tile` at once: one per loaded
 * missile of every built silo within CRUISE_MISSILE_RANGE.
 */
export function cruiseSlotsInRange(
  game: Game,
  player: Player,
  tile: TileRef,
): number {
  const rangeSquared = CRUISE_MISSILE_RANGE * CRUISE_MISSILE_RANGE;
  let slots = 0;
  for (const silo of player.units(UnitType.MissileSilo)) {
    if (!silo.isActive() || silo.isUnderConstruction()) continue;
    if (game.euclideanDistSquared(silo.tile(), tile) > rangeSquared) continue;
    slots += Math.max(0, silo.level() - silo.missileTimerQueue().length);
  }
  return slots;
}

/** Hostile, built flak guns within FLAK_GUN_RANGE of `tile`, by id. */
export function hostileFlakCovering(
  game: Game,
  player: Player,
  tile: TileRef,
): Unit[] {
  return game
    .nearbyUnits(tile, FLAK_GUN_RANGE, UnitType.FlakGun)
    .map(({ unit }) => unit)
    .filter(
      (gun) =>
        gun.owner() !== player &&
        !player.isFriendly(gun.owner(), true) &&
        !gun.isUnderConstruction(),
    )
    .sort((a, b) => a.id() - b.id());
}

/** Rounds `guns` hold loaded right now. */
export function loadedFlakRounds(guns: readonly Unit[]): number {
  let rounds = 0;
  for (const gun of guns) {
    rounds += Math.max(0, FLAK_ROUNDS - gun.missileTimerQueue().length);
  }
  return rounds;
}

/** Drone hits that finish `target` off (see DroneExecution). */
export function droneHitsNeeded(target: Unit): number {
  switch (target.type()) {
    case UnitType.FlakGun:
    case UnitType.TransportShip:
    case UnitType.Convoy:
      return 1;
    case UnitType.Warship:
      return Math.ceil(
        target.health() / droneWarshipDamage(target.maxHealth()),
      );
    default:
      if (target.hasHealth()) {
        return Math.ceil(
          target.health() / droneStructureDamage(target.maxHealth()),
        );
      }
      return Math.max(1, DRONE_HITS_TO_DESTROY_STRUCTURE - target.droneHits());
  }
}

/**
 * Drones a swarm at `target` needs: the hits that finish it, plus one more
 * than every round the hostile flak guns covering it hold loaded (a swarm
 * bigger than the rounds gets through), plus one for a warship's own guns.
 * Null when that is more than a swarm can hold.
 */
export function droneSwarmSize(
  game: Game,
  player: Player,
  target: Unit,
): number | null {
  const rounds = loadedFlakRounds(
    hostileFlakCovering(game, player, target.tile()),
  );
  let size = droneHitsNeeded(target) + rounds;
  if (target.type() === UnitType.Warship) size++;
  return size > DRONE_SWARM_MAX ? null : size;
}

/** Whether our drones are already in the air at `target`. */
export function dronesInFlightAt(player: Player, target: Unit): boolean {
  return player
    .units(UnitType.Drone)
    .some((drone) => drone.targetUnit() === target);
}

/** Whether a flight of ours of `type` is already headed within `radius` of `tile`. */
export function flightInAirAt(
  game: Game,
  player: Player,
  type: UnitType,
  tile: TileRef,
  radius: number,
): boolean {
  const radiusSquared = radius * radius;
  return player.units(type).some((flight) => {
    const target = flight.targetTile();
    return (
      target !== undefined &&
      game.euclideanDistSquared(target, tile) <= radiusSquared
    );
  });
}

/**
 * Whether a flat flight (a ballistic missile, say) from `src` to `dst` at
 * `speed` tiles a tick passes a hostile SAM's range where SAMs can engage
 * it: near either end, as for nukes (AirMissionExecution.updateTargetable).
 */
export function isFlatFlightInterceptable(
  game: Game,
  player: Player,
  src: TileRef,
  dst: TileRef,
  speed: number,
): boolean {
  const path = UniversalPathFinding.Parabola(game, {
    increment: speed,
    distanceBasedHeight: false,
  }).findPath(src, dst);
  if (path === null) return false;
  const config = game.config();
  const targetableSquared = config.defaultNukeTargetableRange() ** 2;
  for (const tile of path) {
    if (
      game.euclideanDistSquared(tile, src) >= targetableSquared &&
      game.euclideanDistSquared(tile, dst) >= targetableSquared
    ) {
      continue;
    }
    if (findEnemySamsCoveringTile(game, player, tile).length > 0) return true;
  }
  return false;
}

/**
 * A drone swarm at `target`, sized by droneSwarmSize, when an airbase is in
 * range, the gold past the reserve pays for every drone, and no drones of
 * ours are already at it. The swarm takes off and pays like a human's.
 */
export function orderDroneSwarm(
  game: Game,
  player: Player,
  target: Unit,
): boolean {
  if (game.config().isUnitDisabled(UnitType.Drone)) return false;
  if (!isDroneTarget(game, player, target)) return false;
  if (dronesInFlightAt(player, target)) return false;
  if (droneAirbases(game, player, target.tile()).length === 0) return false;
  const size = droneSwarmSize(game, player, target);
  if (size === null) return false;
  if (
    spareAirGold(game, player) < priceOf(game, player, UnitType.Drone, size)
  ) {
    return false;
  }
  // The order picks the target nearest the tile it is given: make it this one.
  if (droneTargetAt(game, player, target.tile()) !== target) return false;
  if (player.canBuild(UnitType.Drone, target.tile()) === false) return false;
  game.addExecution(new DroneSwarmExecution(player, target.tile(), size));
  return true;
}

/** An airstrike at `tile` from a ready airbase in range, if the gold allows. */
export function orderAirstrike(
  game: Game,
  player: Player,
  tile: TileRef,
): boolean {
  if (game.config().isUnitDisabled(UnitType.Airstrike)) return false;
  if (
    flightInAirAt(
      game,
      player,
      UnitType.Airstrike,
      tile,
      AIRSTRIKE_STRUCTURE_RADIUS,
    )
  ) {
    return false;
  }
  if (spareAirGold(game, player) < priceOf(game, player, UnitType.Airstrike)) {
    return false;
  }
  if (player.canBuild(UnitType.Airstrike, tile) === false) return false;
  game.addExecution(new AirMissionExecution(UnitType.Airstrike, player, tile));
  return true;
}

/**
 * A cruise missile volley at `tile` big enough to beat the SAMs covering it
 * (cruiseVolleySize), all launched on one tick from silos in range. Never
 * fewer: a smaller volley only feeds the SAMs. `goldFactor` is how many
 * volleys' worth of spare gold the nation wants before it fires one.
 */
export function orderCruiseVolley(
  game: Game,
  player: Player,
  tile: TileRef,
  goldFactor = 1n,
): "fired" | "no_slots" | "no" {
  if (game.config().isUnitDisabled(UnitType.CruiseMissile)) return "no";
  if (
    flightInAirAt(
      game,
      player,
      UnitType.CruiseMissile,
      tile,
      CRUISE_MISSILE_BLAST_RADIUS,
    )
  ) {
    return "no";
  }
  const size = cruiseVolleySize(game, player, tile);
  const cost = priceOf(game, player, UnitType.CruiseMissile, size);
  if (spareAirGold(game, player) < cost * goldFactor) return "no";
  if (cruiseSlotsInRange(game, player, tile) < size) return "no_slots";
  if (player.canBuild(UnitType.CruiseMissile, tile) === false) return "no";
  for (let i = 0; i < size; i++) {
    game.addExecution(
      new AirMissionExecution(UnitType.CruiseMissile, player, tile),
    );
  }
  return "fired";
}

/** What destroying `unit` is worth to a heavy missile, by type and level. */
export function structureStrikeValue(unit: Unit): number {
  const level = unit.level();
  switch (unit.type()) {
    case UnitType.City:
      return 25_000 * level;
    case UnitType.MissileSilo:
      return 50_000 * level;
    case UnitType.SAMLauncher:
      return 30_000 * level;
    case UnitType.Airbase:
      return 40_000;
    case UnitType.Port:
    case UnitType.Factory:
      return 15_000 * level;
    case UnitType.FlakGun:
    case UnitType.CoastalBattery:
      return 10_000;
    case UnitType.DefensePost:
      return 5_000 * level;
    // Like a post: a front-line structure (defense lines).
    case UnitType.SiegeCamp:
      return 5_000;
    default:
      return 0;
  }
}

/**
 * Whether a ballistic missile at `tile` would hit `player`'s own or a
 * friend's (teammate's or ally's, even AFK) structures or land: its blast
 * spares nobody (friendly fire).
 */
export function ballisticBlastHitsFriends(
  game: Game,
  player: Player,
  tile: TileRef,
): boolean {
  const radius = BALLISTIC_MISSILE_BLAST_RADIUS;
  const friendly = (owner: Player) =>
    owner === player || player.isFriendly(owner, true);
  for (const { unit } of game.nearbyUnits(
    tile,
    radius,
    Structures.types,
    undefined,
    true,
  )) {
    if (friendly(unit.owner())) return true;
  }
  const radiusSquared = radius * radius;
  const cx = game.x(tile);
  const cy = game.y(tile);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radiusSquared) continue;
      if (!game.isValidCoord(cx + dx, cy + dy)) continue;
      const owner = game.owner(game.ref(cx + dx, cy + dy));
      if (owner.isPlayer() && friendly(owner)) return true;
    }
  }
  return false;
}
