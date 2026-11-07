import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { assertNever } from "@openfront/engine-lib/Util";
import { Game, Player } from "../../game/Game";

/**
 * How nations treat the world features (engine-lib/game/WorldFeatures.ts).
 * Stateless, and only asked on a nation's attack ticks: a scan of the few
 * ruins, or of the city-states the nation borders. With the features off
 * (or none left) none of it costs a PRNG draw.
 *
 * Prizes: a nation goes for the nearest unclaimed ruin (on free land or
 * under a tribe or city-state) within its range: Easy only within 15 tiles,
 * Medium 40, Hard 80, Impossible 120 (ruinSeekRange), measured from its
 * land's bounding box. On free land its expansion spearheads at the prize;
 * under a tribe, its attack on that tribe does (NationAttackBehavior).
 * Impossible also sends boats to ruins on islands within
 * ISLAND_RUIN_BOAT_RANGE.
 */

/** Impossible boats to an unclaimed ruin on an island within this many tiles. */
export const ISLAND_RUIN_BOAT_RANGE = 60;
/** Land a ruin's island holds at most; past this it counts as a mainland. */
export const ISLAND_MAX_TILES = 4000;

/**
 * How far past its land's bounding box (tiles, manhattan) a nation goes for
 * an unclaimed ruin.
 */
export function ruinSeekRange(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 15;
    case Difficulty.Medium:
      return 40;
    case Difficulty.Hard:
      return 80;
    case Difficulty.Impossible:
      return 120;
    default:
      assertNever(difficulty);
  }
}

/** Manhattan tiles from `player`'s land's bounding box (else its spawn) to each tile; null with neither. */
export function boxGapTo(
  game: Game,
  player: Player,
): ((tile: TileRef) => number) | null {
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
  return (tile) => {
    const x = game.x(tile);
    const y = game.y(tile);
    return Math.max(0, minX - x, x - maxX) + Math.max(0, minY - y, y - maxY);
  };
}

/** Whether `owner` (a small id) leaves a ruin up for grabs: nobody, or a tribe or city-state. */
function heldByNoOne(game: Game, owner: number): boolean {
  if (owner === 0) return true;
  const holder = game.playerBySmallID(owner);
  return (
    holder.isPlayer() &&
    holder.type() !== PlayerType.Human &&
    holder.type() !== PlayerType.Nation
  );
}

/**
 * The prize `player` goes for: the tile of the nearest unclaimed ruin within
 * its range, ties to the first placed. With `holder`, only prizes on that
 * owner's land (0: free land). Null when there is none.
 */
export function prizeToSeek(
  game: Game,
  player: Player,
  holder: number | null = null,
): TileRef | null {
  const difficulty = game.config().difficultyFor(player);
  const ruins = game.ruins();
  const ruinRange = ruins.size > 0 ? ruinSeekRange(difficulty) : 0;
  if (ruinRange === 0) return null;
  const gapTo = boxGapTo(game, player);
  if (gapTo === null) return null;
  const map = game.map();
  let best: TileRef | null = null;
  let bestGap = Infinity;
  const consider = (tile: TileRef, range: number) => {
    const owner = map.ownerID(tile);
    if (!heldByNoOne(game, owner) || (holder !== null && owner !== holder)) {
      return;
    }
    const gap = gapTo(tile);
    if (gap <= range && gap < bestGap) {
      best = tile;
      bestGap = gap;
    }
  };
  for (const tile of ruins.keys()) consider(tile, ruinRange);
  return best;
}

/**
 * Impossible's island ruin: the nearest unclaimed ruin within
 * ISLAND_RUIN_BOAT_RANGE on land `player` can't reach by land (a landmass of
 * at most ISLAND_MAX_TILES with none of `player`'s land), or null.
 */
export function islandRuinToSeek(game: Game, player: Player): TileRef | null {
  if (game.config().difficultyFor(player) !== Difficulty.Impossible) {
    return null;
  }
  const ruins = game.ruins();
  if (ruins.size === 0) return null;
  const gapTo = boxGapTo(game, player);
  if (gapTo === null) return null;
  const candidates: { tile: TileRef; gap: number }[] = [];
  for (const tile of ruins.keys()) {
    if (!heldByNoOne(game, game.ownerID(tile))) continue;
    const gap = gapTo(tile);
    if (gap <= ISLAND_RUIN_BOAT_RANGE) candidates.push({ tile, gap });
  }
  candidates.sort((a, b) => a.gap - b.gap);
  for (const { tile } of candidates) {
    if (onIsland(game, player, tile)) return tile;
  }
  return null;
}

/** Whether `tile`'s landmass is small and holds none of `player`'s land. */
function onIsland(game: Game, player: Player, tile: TileRef): boolean {
  const map = game.map();
  const own = player.smallID();
  const seen = new Set<TileRef>([tile]);
  const stack: TileRef[] = [tile];
  const nbuf: TileRef[] = [0, 0, 0, 0];
  while (stack.length > 0) {
    const t = stack.pop()!;
    if (map.ownerID(t) === own) return false;
    const n = map.neighbors4(t, nbuf);
    for (let i = 0; i < n; i++) {
      const nb = nbuf[i];
      if (!map.isLand(nb) || seen.has(nb)) continue;
      seen.add(nb);
      if (seen.size > ISLAND_MAX_TILES) return false;
      stack.push(nb);
    }
  }
  return true;
}

/** The unclaimed ruin on free land `player`'s expansion spearheads at, or null. */
export function ruinToSeek(game: Game, player: Player): TileRef | null {
  return prizeToSeek(game, player, 0);
}

/** Whether `bot` (a tribe or city-state) sits on a prize `player` goes for. */
export function holdsPrize(game: Game, player: Player, bot: Player): boolean {
  return (
    bot.type() === PlayerType.Bot &&
    prizeToSeek(game, player, bot.smallID()) !== null
  );
}

/**
 * A nation attacks a city-state only once it could send this many times the
 * city-state's garrison: Easy 3.0x, Medium 2.0x, Hard 1.6x, Impossible 1.3x.
 */
export function cityStateStrengthRatio(difficulty: Difficulty): number {
  switch (difficulty) {
    case Difficulty.Easy:
      return 3;
    case Difficulty.Medium:
      return 2;
    case Difficulty.Hard:
      return 1.6;
    case Difficulty.Impossible:
      return 1.3;
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
  const ratio = cityStateStrengthRatio(game.config().difficultyFor(player));
  const available = player.troops() - reserve(weakest);
  return available >= weakest.troops() * ratio ? weakest : null;
}
