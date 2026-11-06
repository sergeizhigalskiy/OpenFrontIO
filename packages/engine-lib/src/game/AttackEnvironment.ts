/**
 * The attack environment: forests, rivers, fords, winter and mud. One rule
 * prices them for every attack (AttackExecution) and for the attack forecast
 * (AttackForecast), so the two always agree.
 *
 * | Factor             | Attacker losses | Attack time | Applies to                    |
 * |--------------------|-----------------|-------------|-------------------------------|
 * | Forest             | 1.2x            | 1.2x        | losses on owned land, time on any |
 * | River              | 1.25x           | 2.0x        | any land                      |
 * | Ford               | 1x              | 1x          |                               |
 * | Winter (snow land) | 1x              | 1.25x       | any land                      |
 * | Mud                | 1x              | 1.5x        | enemy land                    |
 *
 * Together they multiply losses by at most ENVIRONMENT_LOSS_CAP and time by
 * at most ENVIRONMENT_TIME_CAP, or ENVIRONMENT_TIME_CAP_WITH_POST on a tile a
 * defense post covers, so they add texture next to a post without stacking
 * into walls. Upstream's terrain, defense post, fallout and traitor factors
 * are attackLogic's (AttackLogic.ts) and sit outside the cap.
 *
 * The factor numbers live with their features: TerrainFeatures.ts (forest,
 * river, ford), Seasons.ts (winter) and Weather.ts (mud).
 */
import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { WINTER_ATTACK_TIME_MULTIPLIER, winterSlowsAttack } from "./Seasons";
import {
  terrainFeatureLossMultiplier,
  terrainFeatureTimeMultiplier,
} from "./TerrainFeatures";
import { MUD_TILE_COST_MULTIPLIER } from "./Weather";

/** The most the environment multiplies an attacker's troop loss by. */
export const ENVIRONMENT_LOSS_CAP = 1.25;
/** The most the environment multiplies a tile's capture time by. */
export const ENVIRONMENT_TIME_CAP = 2;
/** ...on a tile one of the defender's defense posts covers. */
export const ENVIRONMENT_TIME_CAP_WITH_POST = 1.5;

/** What the environment of one attacked tile is. */
export interface AttackEnvironment {
  feature: TerrainFeature;
  /** A player owns the tile (false for terra nullius). */
  enemyLand: boolean;
  /** It is winter and the tile is snow land. */
  winterSnow: boolean;
  /** A mud front covers the tile. */
  mud: boolean;
  /** One of the defender's defense posts covers the tile. */
  defensePost: boolean;
}

/** The capped multipliers an environment puts on a tile's attack cost. */
export interface EnvironmentCost {
  lossMultiplier: number;
  timeMultiplier: number;
}

/** The table above, capped. */
export function environmentCost(env: AttackEnvironment): EnvironmentCost {
  const loss = terrainFeatureLossMultiplier(env.feature, env.enemyLand);
  let time = terrainFeatureTimeMultiplier(env.feature);
  if (env.winterSnow) time *= WINTER_ATTACK_TIME_MULTIPLIER;
  if (env.mud && env.enemyLand) time *= MUD_TILE_COST_MULTIPLIER;
  return {
    lossMultiplier: Math.min(loss, ENVIRONMENT_LOSS_CAP),
    timeMultiplier: Math.min(
      time,
      env.defensePost ? ENVIRONMENT_TIME_CAP_WITH_POST : ENVIRONMENT_TIME_CAP,
    ),
  };
}

/** What reading a tile's environment needs from the game. */
export interface AttackEnvironmentGame extends GameMap {
  config(): { isWinter(ticksSinceStart: number): boolean };
  /** Ticks since the spawn phase: the seasons' clock. */
  ticksSinceStart(): number;
  /** Mud's tick-cost multiplier at `tile`; 1 without mud. */
  mudTileCostMultiplier(tile: TileRef): number;
}

/**
 * The environment of taking `tile` (from a player when `enemyLand`, else
 * from terra nullius), with `defensePost` saying whether one of the
 * defender's posts covers it.
 */
export function attackEnvironment(
  game: AttackEnvironmentGame,
  tile: TileRef,
  enemyLand: boolean,
  defensePost: boolean,
): AttackEnvironment {
  return {
    feature: game.terrainFeature(tile),
    enemyLand,
    winterSnow: winterSlowsAttack(
      game.config().isWinter(game.ticksSinceStart()),
      game,
      tile,
    ),
    mud: enemyLand && game.mudTileCostMultiplier(tile) !== 1,
    defensePost,
  };
}

/** The two parts of attackLogic's result the environment scales. */
export interface EnvironmentScaledCost {
  attackerTroopLoss: number;
  /** Share of the tick's conquest budget the tile consumes (capture time). */
  tickFraction: number;
}

/**
 * Scales attackLogic's result for a tile by its environment, in place, and
 * returns it. AttackExecution and the forecast both wrap attackLogic with it.
 */
export function withEnvironmentCost<T extends EnvironmentScaledCost>(
  cost: T,
  env: AttackEnvironment,
): T {
  const { lossMultiplier, timeMultiplier } = environmentCost(env);
  cost.attackerTroopLoss *= lossMultiplier;
  cost.tickFraction *= timeMultiplier;
  return cost;
}
