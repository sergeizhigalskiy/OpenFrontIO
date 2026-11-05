/**
 * The attack forecast: what attacking a tile would cost before the player
 * clicks, from the same inputs AttackExecution reads and the same
 * attackLogic it runs (see AttackLogic.ts).
 *
 * Used by the client's hover card. Generic over the player type so the
 * engine's game can be passed too, which is how the tests check the forecast
 * against the simulation.
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { AttackLogicInput, AttackLogicResult } from "./AttackLogic";
import { winterAttackLossMultiplier } from "./Seasons";
import {
  coveringDefensePostLevel,
  DefenseUnitQuery,
  defensePostCoverage,
  POST_COVERAGE_NONE,
  POST_COVERAGE_REDUCED,
} from "./Siege";
import { withTerrainFeatureCost } from "./TerrainFeatures";

/** Mean of the 0-4 tiles of jitter AttackExecution adds to its front each tick. */
export const ATTACK_FRONT_JITTER_MEAN = 2;

/** What the forecast reads about a player. */
export interface ForecastPlayer<P> {
  smallID(): number;
  type(): PlayerType;
  numTilesOwned(): number;
  troops(): number;
  isTraitor(): boolean;
  isDisconnected(): boolean;
  isOnSameTeam(other: P): boolean;
  isFriendly(other: P): boolean;
}

/** A siege camp as the forecast sees it. */
export interface ForecastCamp<P> {
  owner(): P;
  tile(): TileRef;
  isActive(): boolean;
  isUnderConstruction(): boolean;
}

/** What the weather inputs of an attack read (Seasons.ts, Weather.ts). */
export interface AttackWeatherGame extends GameMap {
  config(): { isWinter(ticksSinceStart: number): boolean };
  /** Ticks since the spawn phase: the seasons' clock. */
  ticksSinceStart(): number;
  /** Mud's tick-cost multiplier for taking `tile` from a player; 1 without. */
  mudTileCostMultiplier(tile: TileRef): number;
}

/**
 * The weather multipliers of taking `tile` (from a player when `enemyLand`,
 * else from terra nullius): winter on snow land raises the attacker's loss,
 * a mud front on enemy land the tile's cost. AttackExecution and the
 * forecast both call it, so they agree.
 */
export function attackWeatherInput(
  game: AttackWeatherGame,
  tile: TileRef,
  enemyLand: boolean,
): Pick<
  AttackLogicInput,
  "weatherLossMultiplier" | "weatherTileCostMultiplier"
> {
  return {
    weatherLossMultiplier: winterAttackLossMultiplier(
      game.config().isWinter(game.ticksSinceStart()),
      game,
      tile,
    ),
    weatherTileCostMultiplier: enemyLand ? game.mudTileCostMultiplier(tile) : 1,
  };
}

/** What the forecast reads about the game. */
export interface ForecastGame<P>
  extends GameMap, DefenseUnitQuery, AttackWeatherGame {
  config(): {
    attackLogic(input: AttackLogicInput): AttackLogicResult;
    msPerTick(): number;
    isWinter(ticksSinceStart: number): boolean;
  };
  units(type: UnitType): readonly ForecastCamp<P>[];
}

export interface AttackForecast {
  /** Troops the attacker loses taking the tile (internal units, as troops()). */
  lossPerTile: number;
  /** Tiles taken per second at the start, or null when the front is unknown. */
  tilesPerSecond: number | null;
  /** Highest level of the defender's defense posts covering the tile; 0 if none. */
  defensePostLevel: number;
  /** The covering posts are reduced by siege camps of the attacker's side. */
  siegeReduced: boolean;
}

/**
 * Fills `out` with the tiles of the active (built) siege camps of `attacker`
 * and its friends, and returns how many there are.
 */
export function siegeCampTiles<P>(
  camps: readonly ForecastCamp<P>[],
  isFriend: (owner: P) => boolean,
  out: TileRef[],
): number {
  let count = 0;
  for (const camp of camps) {
    if (!camp.isActive() || camp.isUnderConstruction()) continue;
    if (!isFriend(camp.owner())) continue;
    out[count++] = camp.tile();
  }
  return count;
}

/**
 * How many tiles of each owner (by small id; 0 is terra nullius) an attack
 * from `attackerSmallID`'s border would face: the distinct land, passable
 * neighbors of its border tiles that it doesn't own. This is the border an
 * AttackExecution starts with on that owner.
 */
export function attackFrontSizes(
  map: GameMap,
  borderTiles: Iterable<TileRef>,
  attackerSmallID: number,
): Map<number, number> {
  const seen = new Set<TileRef>();
  const sizes = new Map<number, number>();
  for (const tile of borderTiles) {
    for (const n of map.neighbors(tile)) {
      if (map.isWater(n) || map.isImpassable(n)) continue;
      const owner = map.ownerID(n);
      if (owner === attackerSmallID || seen.has(n)) continue;
      seen.add(n);
      sizes.set(owner, (sizes.get(owner) ?? 0) + 1);
    }
  }
  return sizes;
}

/**
 * The forecast for `attacker` sending `attackTroops` at `tile`, owned by
 * `defender` (null for terra nullius). `frontSize` is the attack's border
 * (attackFrontSizes), or null if unknown. The tile must be passable land.
 */
export function attackForecast<P extends ForecastPlayer<P>>(
  game: ForecastGame<P>,
  attacker: P,
  defender: P | null,
  tile: TileRef,
  attackTroops: number,
  frontSize: number | null,
): AttackForecast {
  let coverage: number = POST_COVERAGE_NONE;
  let defensePostLevel = 0;
  if (defender !== null) {
    const camps: TileRef[] = [];
    const campCount = siegeCampTiles(
      game.units(UnitType.SiegeCamp),
      (owner) => owner === attacker || attacker.isFriendly(owner),
      camps,
    );
    coverage = defensePostCoverage(
      game,
      game,
      tile,
      defender.smallID(),
      camps,
      campCount,
    );
    if (coverage !== POST_COVERAGE_NONE) {
      defensePostLevel = coveringDefensePostLevel(
        game,
        game,
        tile,
        defender.smallID(),
      );
    }
  }
  const borderSize = Math.max(1, frontSize ?? 1) + ATTACK_FRONT_JITTER_MEAN;
  // attackLogic, then the forest, river and ford multipliers on top, as
  // AttackExecution applies them (winter and mud stack inside attackLogic).
  const result = withTerrainFeatureCost(
    game.config().attackLogic({
      terrain: game.terrainType(tile),
      attackTroops: Math.max(1, attackTroops),
      attacker: { type: attacker.type(), numTiles: attacker.numTilesOwned() },
      defender:
        defender === null
          ? null
          : {
              type: defender.type(),
              numTiles: defender.numTilesOwned(),
              troops: defender.troops(),
              isTraitor: defender.isTraitor(),
              isDisconnectedTeammate:
                defender.isDisconnected() && attacker.isOnSameTeam(defender),
            },
      defenderHasDefensePost: coverage !== POST_COVERAGE_NONE,
      siegeCampReducesDefensePost: coverage === POST_COVERAGE_REDUCED,
      falloutRatio: game.hasFallout(tile)
        ? game.numTilesWithFallout() / game.numLandTiles()
        : null,
      borderSize,
      // Winter and mud, as AttackExecution applies them.
      ...attackWeatherInput(game, tile, defender !== null),
    }),
    game.terrainFeature(tile),
    defender !== null,
  );
  const ticksPerSecond = 1000 / game.config().msPerTick();
  return {
    lossPerTile: result.attackerTroopLoss,
    tilesPerSecond:
      frontSize === null || result.tickFraction <= 0
        ? null
        : ticksPerSecond / result.tickFraction,
    defensePostLevel,
    siegeReduced: coverage === POST_COVERAGE_REDUCED,
  };
}
