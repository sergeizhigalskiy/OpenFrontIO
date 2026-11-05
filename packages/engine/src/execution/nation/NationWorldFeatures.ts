import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { assertNever } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";

/**
 * How nations treat the world features (engine-lib/game/WorldFeatures.ts).
 * Stateless, and only asked on a nation's attack ticks: a scan of the few
 * ruins, or of the city-states the nation borders. With the features off
 * (or none left) neither costs a PRNG draw, so games play as before.
 */

/**
 * How far past its land's bounding box (tiles, manhattan) a nation steers
 * its free-land expansion toward an unclaimed ruin. Easy nations don't.
 */
export function ruinSeekRange(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 0;
    case Difficulty.Medium:
      return 30;
    case Difficulty.Hard:
      return 45;
    case Difficulty.Impossible:
      return 60;
    default:
      assertNever(difficulty);
  }
}

/**
 * The unclaimed ruin `player` expands toward: the nearest to its land's
 * bounding box within ruinSeekRange (ties to the first placed), or null.
 * Its expansion attack then spearheads at that tile (AttackExecution).
 */
export function ruinToSeek(game: Game, player: Player): TileRef | null {
  const ruins = game.ruins();
  if (ruins.size === 0) return null;
  const range = ruinSeekRange(game.config().gameConfig().difficulty);
  if (range === 0) return null;
  const box = player.largestClusterBoundingBox;
  const spawn = player.spawnTile();
  let minX: number, minY: number, maxX: number, maxY: number;
  if (box) {
    ({ x: minX, y: minY } = box.min);
    ({ x: maxX, y: maxY } = box.max);
  } else if (spawn !== undefined) {
    minX = maxX = game.x(spawn);
    minY = maxY = game.y(spawn);
  } else {
    return null;
  }
  let best: TileRef | null = null;
  let bestGap = range + 1;
  for (const tile of ruins.keys()) {
    const x = game.x(tile);
    const y = game.y(tile);
    const gap =
      Math.max(0, minX - x, x - maxX) + Math.max(0, minY - y, y - maxY);
    if (gap < bestGap) {
      best = tile;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * A nation attacks a city-state only once it could send this many times the
 * city-state's garrison. Harder nations need less margin.
 */
export function cityStateStrengthRatio(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 4;
    case Difficulty.Medium:
      return 3;
    case Difficulty.Hard:
      return 2.5;
    case Difficulty.Impossible:
      return 2;
    default:
      assertNever(difficulty);
  }
}

/**
 * ...and then on one attack tick in this many (PseudoRandom.chance), so
 * harder nations go for it sooner.
 */
export function cityStateAttackOdds(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 6;
    case Difficulty.Medium:
      return 4;
    case Difficulty.Hard:
      return 2;
    case Difficulty.Impossible:
      return 1;
    default:
      assertNever(difficulty);
  }
}

/**
 * The city-state `player` would attack among `neighbors` (its land
 * neighbors): the weakest hostile one it could send cityStateStrengthRatio
 * times the garrison against, keeping `reserve(target)` home. Null when none.
 */
export function cityStateToAttack(
  game: Game,
  player: Player,
  neighbors: Iterable<Player>,
  reserve: (target: Player) => number,
): Player | null {
  let weakest: Player | null = null;
  for (const n of neighbors) {
    if (!n.isCityState() || player.isFriendly(n)) continue;
    if (weakest === null || n.troops() < weakest.troops()) weakest = n;
  }
  if (weakest === null) return null;
  const ratio = cityStateStrengthRatio(game.config().gameConfig().difficulty);
  const available = player.troops() - reserve(weakest);
  return available >= weakest.troops() * ratio ? weakest : null;
}
