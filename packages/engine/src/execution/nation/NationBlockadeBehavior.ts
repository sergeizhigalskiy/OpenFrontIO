import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { BLOCKADE_RANGE } from "@openfront/engine-lib/game/TradeRoutes";
import { assertNever } from "@openfront/engine-lib/Util";
import type { Game, Player, Unit } from "../../game/Game";
import { tradeFriendly } from "../../game/RailCuts";

/**
 * Nation AI for naval blockades (engine-lib game/TradeRoutes). Stateless and
 * draws nothing from the PRNG, so it needs no snapshot:
 * - Hard and Impossible nations park one warship off the best port of an
 *   enemy they are at war with. Hard does it only with a warship to spare.
 */

/** Warships a Hard nation must own before it sends one to blockade. */
export const NATION_BLOCKADE_MIN_WARSHIPS_HARD = 2;
/** Warships an Impossible nation must own before it sends one to blockade. */
export const NATION_BLOCKADE_MIN_WARSHIPS_IMPOSSIBLE = 1;

function minWarshipsToBlockade(difficulty: Difficulty): number | null {
  switch (difficulty) {
    case Difficulty.Easy:
    case Difficulty.Medium:
      return null;
    case Difficulty.Hard:
      return NATION_BLOCKADE_MIN_WARSHIPS_HARD;
    case Difficulty.Impossible:
      return NATION_BLOCKADE_MIN_WARSHIPS_IMPOSSIBLE;
    default:
      assertNever(difficulty);
  }
}

/** Players we attack or who attack us, unless friendly, by small id. */
function enemiesAtWar(player: Player): Player[] {
  const enemies = new Set<Player>();
  for (const attack of player.outgoingAttacks()) {
    const target = attack.target();
    if (attack.isActive() && target.isPlayer()) enemies.add(target);
  }
  for (const attack of player.incomingAttacks()) {
    if (attack.isActive()) enemies.add(attack.attacker());
  }
  return [...enemies]
    .filter((e) => e.isAlive() && !tradeFriendly(player, e))
    .sort((a, b) => a.smallID() - b.smallID());
}

/** The lowest water tile next to `port` on the water component `component`. */
function waterOff(game: Game, port: Unit, component: number): TileRef | null {
  let best: TileRef | null = null;
  for (const tile of game.neighbors(port.tile())) {
    if (!game.isWater(tile) || game.getWaterComponent(tile) !== component) {
      continue;
    }
    if (best === null || tile < best) best = tile;
  }
  return best;
}

/** Called on the nation's attack ticks. */
export function considerBlockade(game: Game, player: Player): void {
  if (!player.isAlive() || game.config().isUnitDisabled(UnitType.Warship)) {
    return;
  }
  const min = minWarshipsToBlockade(game.config().gameConfig().difficulty);
  if (min === null) return;
  const warships = player.units(UnitType.Warship);
  if (warships.length < min) return;
  const ports = enemiesAtWar(player).flatMap((e) =>
    e.units(UnitType.Port).filter((p) => !p.isUnderConstruction()),
  );
  if (ports.length === 0) return;

  // One blockade at a time: done if one of ours already patrols off a port.
  const rangeSquared = BLOCKADE_RANGE * BLOCKADE_RANGE;
  for (const ship of warships) {
    const patrolTile = ship.warshipState().patrolTile;
    if (
      patrolTile !== undefined &&
      ports.some(
        (p) => game.euclideanDistSquared(p.tile(), patrolTile) <= rangeSquared,
      )
    ) {
      return;
    }
  }

  // Ships with enemies around their patrol tile are busy, as in
  // NationWarshipBehavior.clearSeaLane.
  const busyRange = game.config().warshipTargettingRange();
  const spare = warships.filter((ship) => {
    const state = ship.warshipState();
    return (
      state.state === "patrolling" &&
      (state.patrolTile === undefined ||
        !game.anyUnitNearby(
          state.patrolTile,
          busyRange,
          [UnitType.Warship],
          (u) => u.owner().canAttackPlayer(player, true),
        ))
    );
  });
  if (spare.length === 0) return;

  // The best port first (highest level, then lowest id), the nearest ship.
  ports.sort((a, b) => b.level() - a.level() || a.id() - b.id());
  for (const port of ports) {
    const ships = spare
      .map((ship) => ({
        ship,
        dist: game.manhattanDist(ship.tile(), port.tile()),
      }))
      .sort((a, b) => a.dist - b.dist || a.ship.id() - b.ship.id());
    for (const { ship } of ships) {
      const component = game.getWaterComponent(ship.tile());
      if (component === null) continue;
      const tile = waterOff(game, port, component);
      if (tile === null) continue;
      ship.updateWarshipState({ patrolTile: tile });
      return;
    }
  }
}
