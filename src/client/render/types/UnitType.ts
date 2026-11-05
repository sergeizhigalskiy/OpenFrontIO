/**
 * Canonical unit type string constants.
 *
 * These match the strings the upstream game sends in UnitEventUpdate.unitType.
 * Use these instead of raw string literals to prevent typos and enable
 * find-all-references.
 */

// ---------------------------------------------------------------------------
// Individual unit type constants
// ---------------------------------------------------------------------------

// Mobile units
export const UT_TRANSPORT = "Transport" as const;
export const UT_TRADE_SHIP = "Trade Ship" as const;
export const UT_WARSHIP = "Warship" as const;
export const UT_ATOM_BOMB = "Atom Bomb" as const;
export const UT_HYDROGEN_BOMB = "Hydrogen Bomb" as const;
export const UT_MIRV = "MIRV" as const;
export const UT_SAM_MISSILE = "SAMMissile" as const;
export const UT_SHELL = "Shell" as const;
export const UT_MIRV_WARHEAD = "MIRV Warhead" as const;
export const UT_TRAIN = "Train" as const;
/** Donated troops travelling to an ally. */
export const UT_CONVOY = "Convoy" as const;
/**
 * A minefield on the water. Drawn only for its owner and their friends
 * (MinefieldPass); never as a sprite, bar or FX, which would show it to all.
 */
export const UT_MINEFIELD = "Minefield" as const;

// Structures
export const UT_CITY = "City" as const;
export const UT_PORT = "Port" as const;
export const UT_FACTORY = "Factory" as const;
export const UT_DEFENSE_POST = "Defense Post" as const;
export const UT_SAM_LAUNCHER = "SAM Launcher" as const;
export const UT_MISSILE_SILO = "Missile Silo" as const;
/** Shore gun that shells ships; drawn with the defense post's icon. */
export const UT_COASTAL_BATTERY = "Coastal Battery" as const;
/** Conventional war structures, drawn with the silo's and the SAM's icons. */
export const UT_AIRBASE = "Airbase" as const;
export const UT_FLAK_GUN = "Flak Gun" as const;

// Conventional war flights, drawn with existing sprites (UnitPass).
export const UT_AIRSTRIKE = "Airstrike" as const;
export const UT_AIRDROP = "Airdrop" as const;
export const UT_CRUISE_MISSILE = "Cruise Missile" as const;
export const UT_BALLISTIC_MISSILE = "Ballistic Missile" as const;
export const UT_CLUSTER_MISSILE = "Cluster Missile" as const;
export const UT_CLUSTER_WARHEAD = "Cluster Warhead" as const;
export const UT_DRONE = "Drone" as const;

// ---------------------------------------------------------------------------
// Derived sets
// ---------------------------------------------------------------------------

export const STRUCTURE_TYPES: ReadonlySet<string> = new Set([
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_COASTAL_BATTERY,
  UT_AIRBASE,
  UT_FLAK_GUN,
]);

export const NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
]);

/** Nuke types whose rendered position is interpolated lastPos→pos each render
 *  frame (UnitPass). Their trails stamp only up to lastPos so the tail never
 *  leads the smoothly-moving missile. */
export const SMOOTHED_NUKE_TYPES: ReadonlySet<string> = new Set([
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
]);

/** Units that leave a trail on the map (TrailManager). */
export const TRAIL_TYPES: ReadonlySet<string> = new Set([
  UT_TRANSPORT,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
]);

/** Blast radii (in tiles) matching upstream DefaultConfig.nukeMagnitudes(). */
export const NUKE_MAGNITUDES: Readonly<
  Record<string, { inner: number; outer: number }>
> = {
  [UT_ATOM_BOMB]: { inner: 12, outer: 30 },
  [UT_HYDROGEN_BOMB]: { inner: 80, outer: 100 },
  [UT_MIRV_WARHEAD]: { inner: 12, outer: 18 },
};

// ---------------------------------------------------------------------------
// Ordered lists (atlas column order — used by GPU passes + header)
// ---------------------------------------------------------------------------

/** All unit type strings in the canonical order used by RendererConfig.unitTypes. */
export const ALL_UNIT_TYPES = [
  UT_TRANSPORT,
  UT_TRADE_SHIP,
  UT_WARSHIP,
  UT_ATOM_BOMB,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_MIRV_WARHEAD,
  UT_CITY,
  UT_PORT,
  UT_FACTORY,
  UT_DEFENSE_POST,
  UT_SAM_LAUNCHER,
  UT_MISSILE_SILO,
  UT_TRAIN,
  UT_CONVOY,
  UT_MINEFIELD,
  UT_COASTAL_BATTERY,
  UT_AIRBASE,
  UT_AIRSTRIKE,
  UT_AIRDROP,
  UT_CRUISE_MISSILE,
  UT_FLAK_GUN,
  UT_DRONE,
  UT_BALLISTIC_MISSILE,
  UT_CLUSTER_MISSILE,
  UT_CLUSTER_WARHEAD,
] as const;
