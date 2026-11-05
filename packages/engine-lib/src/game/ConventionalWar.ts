/**
 * Conventional war rules: airbases, airstrikes, airdrops, cruise, ballistic
 * and cluster missiles, flak guns, drones and capitals.
 *
 * A lobby setting (GameConfig.conventionalWar). When it is on, atom bombs,
 * hydrogen bombs and MIRVs are disabled and the air units here are enabled;
 * when it is off, the air units are disabled and capitals do nothing.
 *
 * Shared by the engine (placement, cost, combat) and the client (build menu,
 * range previews, capital markers), so every tunable number lives here. All
 * math is integer, so the engine stays deterministic.
 *
 * Weapon tiers: the weapon types are the tiers, as atom bomb, hydrogen bomb
 * and MIRV are. Killing a SAM is never cheaper than with nukes (an atom bomb
 * is 750k): cruise missiles and airstrikes cost the same and can destroy any
 * military structure, SAMs included. SAMs shoot each down with one missile,
 * so a level-L SAM (L loaded missiles) takes L + 1 of them, as with atom
 * bombs. Drones are the lowest tier: cheap, but they never hurt SAMs. Above
 * the cruise missile, the ballistic missile takes the hydrogen bomb's rung and
 * the cluster missile the MIRV's, but neither leaves fallout or takes land.
 */
import {
  DRONE_SWARM_DEFAULT,
  DRONE_SWARM_MAX,
  DRONE_SWARM_MIN,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";

export { DRONE_SWARM_DEFAULT, DRONE_SWARM_MAX, DRONE_SWARM_MIN };

/** Units that exist only in conventional war. */
export const CONVENTIONAL_WAR_UNIT_TYPES: readonly UnitType[] = [
  UnitType.Airbase,
  UnitType.Airstrike,
  UnitType.Airdrop,
  UnitType.CruiseMissile,
  UnitType.FlakGun,
  UnitType.Drone,
  UnitType.BallisticMissile,
  UnitType.ClusterMissile,
  UnitType.ClusterWarhead,
];

/** Units conventional war disables. */
export const NUCLEAR_UNIT_TYPES: readonly UnitType[] = [
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
  UnitType.MIRVWarhead,
];

// ---------------------------------------------------------------------------
// Airbase
// ---------------------------------------------------------------------------

/** Price of the first airbase; each one owned adds this much again. */
export const AIRBASE_BASE_COST = 300_000;

/** Airbases never cost more than this. */
export const AIRBASE_MAX_COST = 1_200_000;

/** Build time in ticks (10 s). */
export const AIRBASE_CONSTRUCTION_TICKS = 100;

/** Ticks for a flown sortie to recharge (25 s). An airbase holds one. */
export const AIRBASE_SORTIE_RECHARGE_TICKS = 250;

/** Tiles (euclidean) from a ready airbase to an airstrike or airdrop target. */
export const AIRBASE_STRIKE_RANGE = 150;

/** Price of an airbase for a player who already owns `owned` of them. */
export function airbaseCost(owned: number): number {
  return Math.min(
    AIRBASE_MAX_COST,
    (Math.max(0, owned) + 1) * AIRBASE_BASE_COST,
  );
}

// ---------------------------------------------------------------------------
// Flights (airstrike and airdrop planes, cruise missiles)
// ---------------------------------------------------------------------------

/** Tiles a plane flies per tick. */
export const PLANE_SPEED = 6;

/** Tiles a cruise missile flies per tick: low, fast and flat. */
export const CRUISE_MISSILE_SPEED = 12;

/** Planes that SAMs and flak guns shoot at (SAMs also take nukes). */
export const PLANE_TYPES: readonly UnitType[] = [
  UnitType.Airstrike,
  UnitType.Airdrop,
];

/** What flak guns shoot at: the planes and drones. Never cruise missiles. */
export const FLAK_TARGET_TYPES: readonly UnitType[] = [
  ...PLANE_TYPES,
  UnitType.Drone,
];

/**
 * SAMs shoot planes and cruise missiles down exactly as they do nukes:
 * pre-aimed missiles that always hit, one per loaded tube, each reloading for
 * SAMCooldown ticks. The counterplay is saturation: a volley of more cruise
 * missiles than a SAM has loaded gets the extras through, as MIRVs do.
 */
export const SAM_TARGET_FLIGHT_TYPES: readonly UnitType[] = [
  UnitType.Airstrike,
  UnitType.Airdrop,
  UnitType.CruiseMissile,
  UnitType.BallisticMissile,
  // Like a MIRV: the cluster carrier can't be intercepted, its warheads can.
  UnitType.ClusterWarhead,
];

/** Structures an airstrike or a cruise missile can destroy. */
export const MILITARY_STRUCTURE_TYPES: readonly UnitType[] = [
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.CoastalBattery,
  UnitType.Airbase,
  UnitType.MissileSilo,
  UnitType.FlakGun,
];

// ---------------------------------------------------------------------------
// Airstrike
// ---------------------------------------------------------------------------

/** Gold per airstrike: the atom bomb's tier. */
export const AIRSTRIKE_COST = 750_000;

/** The strike destroys the military structures within this many tiles. */
export const AIRSTRIKE_STRUCTURE_RADIUS = 2;

/** Percent of the target owner's troops the strike kills... */
export const AIRSTRIKE_TROOP_KILL_PERCENT = 4;

/** ...but never more than this. */
export const AIRSTRIKE_MAX_TROOP_KILL = 40_000;

/** Attacks by the target owner whose front comes this close are hit too. */
export const AIRSTRIKE_FRONT_RADIUS = 10;

/** Percent of each such attack's troops the strike kills... */
export const AIRSTRIKE_FRONT_KILL_PERCENT = 15;

/** ...never more than this over all of those attacks together. */
export const AIRSTRIKE_MAX_FRONT_KILL = 40_000;

/** Troops an airstrike kills from a target owner holding `troops`. */
export function airstrikeTroopKills(troops: number): number {
  return Math.min(
    AIRSTRIKE_MAX_TROOP_KILL,
    Math.floor((Math.max(0, troops) * AIRSTRIKE_TROOP_KILL_PERCENT) / 100),
  );
}

/**
 * Troops an airstrike kills from each attack of `attackTroops`, in order:
 * AIRSTRIKE_FRONT_KILL_PERCENT of each, until AIRSTRIKE_MAX_FRONT_KILL is
 * used up.
 */
export function airstrikeFrontKills(attackTroops: readonly number[]): number[] {
  let left = AIRSTRIKE_MAX_FRONT_KILL;
  return attackTroops.map((troops) => {
    const kill = Math.min(
      left,
      Math.floor((Math.max(0, troops) * AIRSTRIKE_FRONT_KILL_PERCENT) / 100),
    );
    left -= kill;
    return kill;
  });
}

// ---------------------------------------------------------------------------
// Airdrop
// ---------------------------------------------------------------------------

/** Gold per airdrop. */
export const AIRDROP_COST = 100_000;

/** An airdrop carries at most this percent of the sender's max troops. */
export const AIRDROP_MAX_TROOPS_PERCENT = 15;

/** Troops an airdrop carries when `requested` are asked for. */
export function airdropTroops(
  requested: number,
  troops: number,
  maxTroops: number,
): number {
  return Math.max(
    0,
    Math.floor(
      Math.min(
        requested,
        troops,
        (maxTroops * AIRDROP_MAX_TROOPS_PERCENT) / 100,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Cruise missile
// ---------------------------------------------------------------------------

/** Gold per cruise missile: the atom bomb's tier. */
export const CRUISE_MISSILE_COST = 750_000;

/** Tiles (euclidean) from a ready missile silo to a cruise missile target. */
export const CRUISE_MISSILE_RANGE = 400;

/**
 * It destroys the military structures within this many tiles. Cluster
 * warheads use it too, so the two stay in sync.
 */
export const CRUISE_MISSILE_BLAST_RADIUS = 3;

/**
 * Whether `weapon` can destroy a SAM of `samLevel`: the one place that
 * decides it. Airstrikes and cruise missiles can (their price is what keeps
 * SAMs from dying cheaply); drones, the lowest tier, never can.
 */
export function canDestroySam(weapon: UnitType, samLevel: number): boolean {
  switch (weapon) {
    case UnitType.Airstrike:
    case UnitType.CruiseMissile:
    case UnitType.BallisticMissile:
    case UnitType.ClusterWarhead:
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Ballistic missile (the hydrogen bomb's rung)
// ---------------------------------------------------------------------------

/** Gold per ballistic missile, the same as a hydrogen bomb. */
export const BALLISTIC_MISSILE_COST = 5_000_000;

/** It launches only from a missile silo of at least this level. */
export const BALLISTIC_MISSILE_SILO_LEVEL = 2;

/** Tiles per tick: twice a hydrogen bomb's, so SAMs get less time. */
export const BALLISTIC_MISSILE_SPEED = 20;

/** Every hostile structure within this many tiles is destroyed. */
export const BALLISTIC_MISSILE_BLAST_RADIUS = 20;

/**
 * Percent of current troops it kills from each player owning land in the
 * blast, and from each of their attacks whose front lies in it.
 */
export const BALLISTIC_MISSILE_TROOP_KILL_PERCENT = 10;

/** Troops a ballistic missile kills out of `troops`. */
export function ballisticTroopKills(troops: number): number {
  return Math.floor(
    (Math.max(0, troops) * BALLISTIC_MISSILE_TROOP_KILL_PERCENT) / 100,
  );
}

// ---------------------------------------------------------------------------
// Cluster missile (the MIRV's rung, cheaper because weaker)
// ---------------------------------------------------------------------------

/** Price of the first cluster missile of the game. */
export const CLUSTER_MISSILE_BASE_COST = 10_000_000;

/** Each cluster missile launched in the game, by anyone, adds this. */
export const CLUSTER_MISSILE_COST_INCREASE = 5_000_000;

/** It launches only from a missile silo of at least this level. */
export const CLUSTER_MISSILE_SILO_LEVEL = 3;

/** Tiles per tick of the carrier (a MIRV's speed). */
export const CLUSTER_MISSILE_SPEED = 15;

/** Tiles per tick of each warhead (a MIRV warhead's speed). */
export const CLUSTER_WARHEAD_SPEED = 22;

/** Warheads the carrier splits into. */
export const CLUSTER_WARHEAD_COUNT = 8;

/** The carrier splits this many tiles (euclidean) short of the target. */
export const CLUSTER_SEPARATION_DISTANCE = 100;

/** Each warhead picks a structure within this many tiles of the target. */
export const CLUSTER_SPREAD_RADIUS = 40;

/**
 * Price of a cluster missile once `launched` have been launched this game:
 * CLUSTER_MISSILE_BASE_COST + CLUSTER_MISSILE_COST_INCREASE x launched. The
 * count is the cluster missiles' own, apart from MIRVs.
 */
export function clusterMissileCost(launched: number): number {
  return (
    CLUSTER_MISSILE_BASE_COST +
    CLUSTER_MISSILE_COST_INCREASE * Math.max(0, launched)
  );
}

// ---------------------------------------------------------------------------
// Flak gun
// ---------------------------------------------------------------------------

/** Price of the first flak gun; each one owned adds this much again. */
export const FLAK_GUN_BASE_COST = 250_000;

/** Flak guns never cost more than this. */
export const FLAK_GUN_MAX_COST = 1_000_000;

/** Build time in ticks (10 s), like an airbase. */
export const FLAK_GUN_CONSTRUCTION_TICKS = 100;

/** Tiles (euclidean) within which a flak gun fires at planes. */
export const FLAK_GUN_RANGE = 40;

/**
 * Rounds a flak gun holds. Like a SAM's missiles: each round fired starts its
 * own reload (the unit's missile timer queue), the gun fires whenever one is
 * loaded, at most one per tick, and can't fire with all of them reloading.
 */
export const FLAK_ROUNDS = 2;

/** Ticks for a fired round to reload (3 s). */
export const FLAK_GUN_RELOAD_TICKS = 30;

/**
 * Percent chance a round shoots its plane or drone down. A miss still uses
 * the round, so several guns layer up. Flak fires only at airstrike and
 * airdrop planes and drones: never at cruise missiles, nukes or ships.
 */
export const FLAK_GUN_HIT_PERCENT = 35;

/** Price of a flak gun for a player who already owns `owned` of them. */
export function flakGunCost(owned: number): number {
  return Math.min(
    FLAK_GUN_MAX_COST,
    (Math.max(0, owned) + 1) * FLAK_GUN_BASE_COST,
  );
}

// ---------------------------------------------------------------------------
// Drones (loitering munitions)
// ---------------------------------------------------------------------------

/** Gold per drone. */
export const DRONE_COST = 40_000;

/** A drone's target must be within this many tiles (euclidean) of an airbase. */
export const DRONE_RANGE = 100;

/**
 * Each airbase launches at most one drone per this many ticks. Drones don't
 * use the airstrike and airdrop sortie: a swarm order (1 to DRONE_SWARM_MAX
 * drones) is split across every airbase in range and queued until all are
 * out. Each drone is paid for as it takes off; the queue stops when the gold
 * runs out.
 */
export const DRONE_LAUNCH_INTERVAL_TICKS = 10;

/** A swarm size an order may ask for: an integer in [MIN, MAX], else 1. */
export function clampDroneSwarm(count: number | null | undefined): number {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return DRONE_SWARM_MIN;
  }
  return Math.min(
    DRONE_SWARM_MAX,
    Math.max(DRONE_SWARM_MIN, Math.floor(count)),
  );
}

/**
 * Tiles a drone flies per tick: a slow loiter that still runs down a ship (1
 * tile per tick). A lone drone spends 20 ticks in a flak gun's range, enough
 * for both of its rounds, so the gun usually beats one drone and a swarm
 * beats the gun.
 */
export const DRONE_SPEED = 2;

/** A drone that hasn't reached its target after this many ticks is lost. */
export const DRONE_MAX_FLIGHT_TICKS = 600;

/** What a drone can hunt, and nothing else: never SAMs. */
export const DRONE_TARGET_TYPES: readonly UnitType[] = [
  UnitType.FlakGun,
  UnitType.Warship,
  UnitType.TransportShip,
  UnitType.Convoy,
];

/** A click picks the nearest valid target within this many tiles of it. */
export const DRONE_TARGET_PICK_RADIUS = 8;

/**
 * A drone whose target is destroyed or captured mid-flight retargets the
 * nearest valid target within this many tiles of it, or is lost.
 */
export const DRONE_RETARGET_RADIUS = 15;

/** Hits that sink a full-health warship. */
export const DRONE_HITS_TO_SINK_WARSHIP = 3;

/**
 * Damage one drone hit does to a warship of `maxHealth`: a third, rounded
 * up, so exactly DRONE_HITS_TO_SINK_WARSHIP hits sink a full-health ship.
 */
export function droneWarshipDamage(maxHealth: number): number {
  return Math.ceil(maxHealth / DRONE_HITS_TO_SINK_WARSHIP);
}

/** Percent chance each warship shell aimed at a drone shoots it down. */
export const WARSHIP_DRONE_HIT_PERCENT = 50;

/** A flak gun reports drones it shot down at most once per this many ticks. */
export const FLAK_DRONE_REPORT_INTERVAL_TICKS = 50;

// ---------------------------------------------------------------------------
// Capitals
// ---------------------------------------------------------------------------

/** Percent of current troops a player loses with their capital. */
export const CAPITAL_TROOP_LOSS_PERCENT = 25;

/** Percent of current gold a player loses with their capital, to the captor. */
export const CAPITAL_GOLD_LOSS_PERCENT = 25;

/** A capital moves at most once per this many ticks (2 minutes). */
export const CAPITAL_MOVE_COOLDOWN_TICKS = 1200;
