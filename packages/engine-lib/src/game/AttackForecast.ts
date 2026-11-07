/**
 * The attack forecast: what attacking a tile would cost before the player
 * clicks, from the same inputs AttackExecution reads and the same rules it
 * runs: attackLogic (AttackLogic.ts), the environment and its cap
 * (AttackEnvironment.ts), the spearhead's budget cap, and its supply line
 * (spearOverextension at the tile's depth).
 *
 * Used by the client's hover card. Generic over the player type so the
 * engine's game can be passed too, which is how the tests check the forecast
 * against the simulation.
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import {
  attackEnvironment,
  AttackEnvironment,
  AttackEnvironmentGame,
  withEnvironmentCost,
} from "./AttackEnvironment";
import {
  attackBudgetFront,
  AttackLogicInput,
  AttackLogicResult,
  spearOriginFor,
} from "./AttackLogic";
import { defensePostCovers, DefenseUnitQuery } from "./DefensePosts";

/** `env` with no terrain feature when `drop`. */
function withoutFeatures(
  env: AttackEnvironment,
  drop: boolean,
): AttackEnvironment {
  return drop ? { ...env, feature: TerrainFeature.None } : env;
}

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
  isCityState(): boolean;
  isOnSameTeam(other: P): boolean;
}

/** What the forecast reads about the game. */
export interface ForecastGame extends DefenseUnitQuery, AttackEnvironmentGame {
  config(): {
    attackLogic(input: AttackLogicInput): AttackLogicResult;
    msPerTick(): number;
    isWinter(ticksSinceStart: number): boolean;
  };
}

export interface AttackForecast {
  /** Troops the attacker loses taking the tile (internal units, as troops()). */
  lossPerTile: number;
  /** Tiles taken per second at the start, or null when the front is unknown. */
  tilesPerSecond: number | null;
  /** One of the defender's defense posts covers the tile. */
  defensePost: boolean;
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
 * How deep `tile` lies on a spearhead clicked at it now (spearDepth with the
 * tile as its focus): its manhattan distance from the spear's origin
 * (spearOriginFor): the attacker's tile nearest `tile` among `borderTiles`,
 * or the origin of `line`, its remembered spear line on the tile's owner
 * (Player.spearLine), when the spearhead would merge into a running one
 * (`running`) or start near that line's tip. 0 without a border.
 */
export function spearDepthAt(
  map: GameMap,
  tile: TileRef,
  line: { origin: TileRef; tip: TileRef } | null,
  borderTiles: Iterable<TileRef>,
  running = false,
): number {
  let natural: TileRef | null = null;
  let best = Infinity;
  for (const t of borderTiles) {
    const d = map.manhattanDist(t, tile);
    if (d < best || (d === best && natural !== null && t < natural)) {
      best = d;
      natural = t;
    }
  }
  if (natural === null) {
    return line === null ? 0 : map.manhattanDist(line.origin, tile);
  }
  const origin = spearOriginFor(natural, line, running, (a, b) =>
    map.manhattanDist(a, b),
  );
  return map.manhattanDist(origin, tile);
}

/**
 * The forecast for `attacker` sending `attackTroops` at `tile`, owned by
 * `defender` (null for terra nullius). `frontSize` is the attack's border
 * (attackFrontSizes), or null if unknown. `spearhead` prices an attack
 * focused on the tile, whose budget comes from at most SPEAR_BUDGET_FRONT
 * of that border, as a click sends, with the tile `spearDepth` deep on the
 * spear (spearDepthAt). The tile must be passable land.
 * `terrainFeatures` false prices the tile as if it had no forest, river or
 * ford (Medium nations read the forecast that way).
 */
export function attackForecast<P extends ForecastPlayer<P>>(
  game: ForecastGame,
  attacker: P,
  defender: P | null,
  tile: TileRef,
  attackTroops: number,
  frontSize: number | null,
  spearhead: boolean,
  terrainFeatures = true,
  spearDepth = 0,
): AttackForecast {
  const defenderHasDefensePost =
    defender !== null && defensePostCovers(game, tile, defender.smallID());
  const borderSize =
    attackBudgetFront(Math.max(1, frontSize ?? 1), spearhead) +
    ATTACK_FRONT_JITTER_MEAN;
  const result = withEnvironmentCost(
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
              isCityState: defender.isCityState(),
            },
      defenderHasDefensePost,
      falloutRatio: game.hasFallout(tile)
        ? game.numTilesWithFallout() / game.numLandTiles()
        : null,
      borderSize,
      spearDepth: spearhead ? spearDepth : 0,
    }),
    // Forest, river, ford, winter and mud, capped, as AttackExecution does.
    withoutFeatures(
      attackEnvironment(game, tile, defender !== null, defenderHasDefensePost),
      !terrainFeatures,
    ),
  );
  const ticksPerSecond = 1000 / game.config().msPerTick();
  return {
    lossPerTile: result.attackerTroopLoss,
    tilesPerSecond:
      frontSize === null || result.tickFraction <= 0
        ? null
        : ticksPerSecond / result.tickFraction,
    defensePost: defenderHasDefensePost,
  };
}
