import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { renderNumber, renderTroops } from "@openfront/engine-lib/Format";
import {
  CAPITAL_GOLD_LOSS_PERCENT,
  CAPITAL_MOVE_COOLDOWN_TICKS,
  CAPITAL_TROOP_LOSS_PERCENT,
} from "@openfront/engine-lib/game/ConventionalWar";
import { Game, Player, Unit } from "./Game";

/**
 * Conventional war capitals (numbers in engine-lib/game/ConventionalWar.ts).
 *
 * Every player but a tribe has a capital, their spawn tile until it moves.
 * When an enemy conquers it, the owner loses CAPITAL_TROOP_LOSS_PERCENT of
 * their troops and CAPITAL_GOLD_LOSS_PERCENT of their gold, which goes to the
 * conqueror, and the capital moves to their highest-level city, else near the
 * center of their largest territory.
 *
 * A capital moves at most once per CAPITAL_MOVE_COOLDOWN_TICKS, so the
 * penalty can't chain: a capital conquered within that window costs nothing
 * and stays put until the window ends, then moves (again without a penalty)
 * if its tile is still lost. All state is on the player (capitalTile,
 * capitalMovedTick), so nothing here needs a snapshot.
 */

/** Whether `player`'s capital may move at `now`. */
function canMove(player: Player, now: number): boolean {
  const moved = player.capitalMovedTick();
  return moved === null || now - moved >= CAPITAL_MOVE_COOLDOWN_TICKS;
}

/** Called when `conqueror` takes `loser`'s capital tile (GameImpl.conquer). */
export function onCapitalConquered(
  game: Game,
  loser: Player,
  conqueror: Player,
): void {
  if (conqueror === loser || conqueror.isFriendly(loser, true)) return;
  const now = game.ticks();
  if (!canMove(loser, now)) return;

  const troops = loser.removeTroops(
    Math.floor((loser.troops() * CAPITAL_TROOP_LOSS_PERCENT) / 100),
  );
  const gold = loser.removeGold(
    (loser.gold() * BigInt(CAPITAL_GOLD_LOSS_PERCENT)) / 100n,
  );
  if (gold > 0n) conqueror.addGold(gold);
  const next = newCapitalTile(game, loser);
  if (next !== null) loser.moveCapital(next, now);

  game.displayMessage(
    "events_display.capital_lost",
    MessageType.ATTACK_FAILED,
    loser.id(),
    undefined,
    {
      name: conqueror.displayName(),
      troops: renderTroops(troops),
      gold: renderNumber(gold),
    },
    undefined,
    conqueror.id(),
  );
  game.displayMessage(
    "events_display.capital_captured",
    MessageType.CONQUERED_PLAYER,
    conqueror.id(),
    gold,
    { name: loser.displayName(), gold: renderNumber(gold) },
    undefined,
    loser.id(),
  );
}

/**
 * Moves `player`'s capital, without a penalty, once the move window allows
 * it, when they no longer own its tile (it was conquered within the window,
 * or lost some other way). Cheap when nothing changed; PlayerExecution calls
 * it every tick.
 */
export function maybeRelocateCapital(game: Game, player: Player): void {
  const capital = player.capitalTile();
  if (capital === undefined || game.owner(capital) === player) return;
  if (game.inSpawnPhase()) return;
  const now = game.ticks();
  if (!canMove(player, now)) return;
  const next = newCapitalTile(game, player);
  if (next === null) return;
  player.moveCapital(next, now);
  game.displayMessage(
    "events_display.capital_moved",
    MessageType.ATTACK_FAILED,
    player.id(),
  );
}

/**
 * Where a capital moves: the player's highest-level built city (ties to the
 * lowest id), else the owned tile nearest the center of their largest
 * territory. Null when they own nothing.
 */
export function newCapitalTile(game: Game, player: Player): TileRef | null {
  let city: Unit | null = null;
  for (const c of player.units(UnitType.City)) {
    if (!c.isActive() || c.isUnderConstruction()) continue;
    if (game.owner(c.tile()) !== player) continue;
    if (
      city === null ||
      c.level() > city.level() ||
      (c.level() === city.level() && c.id() < city.id())
    ) {
      city = c;
    }
  }
  if (city !== null) return city.tile();
  return largestTerritoryCenter(game, player);
}

/**
 * The owned tile nearest the centroid of `player`'s largest connected
 * territory. Independent of tile iteration order: the largest territory wins,
 * ties to the one holding the lowest tile ref, and the nearest tile wins,
 * ties to the lowest ref.
 */
export function largestTerritoryCenter(
  game: Game,
  player: Player,
): TileRef | null {
  const owned = player.tiles();
  const seen = new Set<TileRef>();
  const neighbors: TileRef[] = [];
  let best: TileRef[] | null = null;
  let bestMin = 0;
  for (const start of owned) {
    if (seen.has(start)) continue;
    const cluster: TileRef[] = [start];
    seen.add(start);
    let min = start;
    for (let i = 0; i < cluster.length; i++) {
      neighbors.length = 0;
      for (const n of game.neighbors(cluster[i])) neighbors.push(n);
      for (const n of neighbors) {
        if (seen.has(n) || game.owner(n) !== player) continue;
        seen.add(n);
        cluster.push(n);
        if (n < min) min = n;
      }
    }
    if (
      best === null ||
      cluster.length > best.length ||
      (cluster.length === best.length && min < bestMin)
    ) {
      best = cluster;
      bestMin = min;
    }
  }
  if (best === null) return null;

  let sumX = 0;
  let sumY = 0;
  for (const t of best) {
    sumX += game.x(t);
    sumY += game.y(t);
  }
  const cx = Math.floor(sumX / best.length);
  const cy = Math.floor(sumY / best.length);
  let center = best[0];
  let centerDist = Infinity;
  for (const t of best) {
    const dx = game.x(t) - cx;
    const dy = game.y(t) - cy;
    const dist = dx * dx + dy * dy;
    if (dist < centerDist || (dist === centerDist && t < center)) {
      center = t;
      centerDist = dist;
    }
  }
  return center;
}
