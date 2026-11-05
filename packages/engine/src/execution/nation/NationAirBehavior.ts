import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRSTRIKE_COST,
  CRUISE_MISSILE_COST,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Attack, Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";

/**
 * A nation's conservative use of conventional war air power. Stateless and
 * draws nothing from the PRNG, so it needs no snapshot:
 * - build one airbase, near the capital, once rich;
 * - airstrike an enemy defense post covering the front of one of its attacks;
 * - when an enemy SAM covers that post, send a cruise missile at the SAM
 *   first instead.
 * Every spend keeps NATION_AIR_RESERVE_GOLD in hand.
 */

/** Gold a nation keeps after any air spend. */
export const NATION_AIR_RESERVE_GOLD = 1_000_000;

/** A nation builds its airbase once it holds this much gold. */
export const NATION_AIRBASE_MIN_GOLD = 2_000_000;

/** True when some tile of `attack`'s front is within `range` of `tile`. */
function frontWithin(
  game: Game,
  attack: Attack,
  tile: TileRef,
  range: number,
): boolean {
  const rangeSquared = range * range;
  for (const t of attack.borderTiles()) {
    if (game.euclideanDistSquared(t, tile) <= rangeSquared) return true;
  }
  return false;
}

/** Called on the nation's attack ticks. */
export function considerAirPower(game: Game, player: Player): void {
  if (!game.config().conventionalWar() || !player.isAlive()) return;
  if (maybeBuildAirbase(game, player)) return;
  maybeStrikeDefensePost(game, player);
}

function maybeBuildAirbase(game: Game, player: Player): boolean {
  if (player.units(UnitType.Airbase).length > 0) return false;
  if (player.gold() < BigInt(NATION_AIRBASE_MIN_GOLD)) return false;
  const tile = player.capitalTile() ?? player.spawnTile();
  if (tile === undefined) return false;
  if (player.canBuild(UnitType.Airbase, tile) === false) return false;
  game.addExecution(new ConstructionExecution(player, UnitType.Airbase, tile));
  return true;
}

/** The spare gold beyond the reserve. */
function spare(player: Player): bigint {
  return player.gold() - BigInt(NATION_AIR_RESERVE_GOLD);
}

function maybeStrikeDefensePost(game: Game, player: Player): void {
  // Nothing to fly from: skip the search.
  const hasReadyBase = player
    .units(UnitType.Airbase)
    .some((b) => !b.isUnderConstruction() && !b.isInCooldown());
  if (!hasReadyBase || spare(player) < BigInt(AIRSTRIKE_COST)) return;

  for (const attack of player.outgoingAttacks()) {
    const target = attack.target();
    if (!attack.isActive() || !target.isPlayer()) continue;
    const posts = target
      .units(UnitType.DefensePost)
      .filter((p) => p.isActive() && !p.isUnderConstruction())
      .sort((a, b) => a.id() - b.id());
    for (const post of posts) {
      const range = game.config().defensePostRange(post.level());
      if (!frontWithin(game, attack, post.tile(), range)) continue;
      if (player.canBuild(UnitType.Airstrike, post.tile()) === false) continue;
      const sam = coveringSam(game, player, post.tile());
      if (sam !== null) {
        // Clear the SAM first; the plane would only be shot down.
        if (
          spare(player) >= BigInt(CRUISE_MISSILE_COST) &&
          player.canBuild(UnitType.CruiseMissile, sam.tile()) !== false
        ) {
          game.addExecution(
            new ConstructionExecution(
              player,
              UnitType.CruiseMissile,
              sam.tile(),
            ),
          );
        }
        return;
      }
      game.addExecution(
        new ConstructionExecution(player, UnitType.Airstrike, post.tile()),
      );
      return;
    }
  }
}

/** The lowest-id hostile SAM whose range covers `tile`, or null. */
function coveringSam(game: Game, player: Player, tile: TileRef): Unit | null {
  const config = game.config();
  let best: Unit | null = null;
  for (const { unit, distSquared } of game.nearbyUnits(
    tile,
    config.maxSamRange(),
    UnitType.SAMLauncher,
  )) {
    if (unit.owner() === player || player.isFriendly(unit.owner(), true)) {
      continue;
    }
    const range = config.samRange(unit.level());
    if (distSquared > range * range) continue;
    if (best === null || unit.id() < best.id()) best = unit;
  }
  return best;
}
