import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  SPEAR_FREE_DEPTH,
  spearDepth,
} from "@openfront/engine-lib/game/AttackLogic";
import { Game, Player, SpearLine } from "../../game/Game";

/**
 * Salients: land a hostile player's spearhead took deep into a nation, and
 * the neck the nation cuts it at (NationAttackBehavior.answerSalient, Medium
 * and up). Stateless and draws nothing from the PRNG.
 *
 * A salient is the player's land more than SPEAR_FREE_DEPTH deep on one of
 * its spear lines into the nation (Player.spearLine: the line's tip and how
 * deep it got), or a long tongue of its land walled in by the nation alone
 * that the nation's own survey finds (surveySalients).
 *
 * The neck is the narrowest cross-section between the tip and the player's
 * main land, and narrower than it lies from the tip: a wider one makes the
 * land a front, not a salient. Cross-sections are the rings of a breadth-first growth of the
 * player's land from the tip, 8-connected: every path of its land from the
 * tip to its main land crosses each ring, so taking one ring cuts off all
 * the land before it. The rings stop at the main land: for a spear line, the
 * first ring reaching back within SPEAR_FREE_DEPTH of the line's origin; for
 * a surveyed tongue, the first ring that fans out to SURVEY_FAN_OUT times the
 * narrowest one before it, or touches anything but the two players' land (a
 * third player, free land, water or the map edge).
 */

/** Tiles a neck search grows at most; a bigger salient isn't judged. */
export const NATION_SALIENT_SEARCH_TILES = 4096;
/**
 * Rings next to the tip that are never the neck: a spear tapers to its tip,
 * so the rings there are narrow without cutting anything worth having.
 */
export const NATION_NECK_TIP_MARGIN = 6;
/** Tip-like front tiles a survey grows from, per player. */
const SURVEY_SEEDS = 4;
/** A front tile is tip-like (a corner) when this many of its 4 neighbors are ours. */
const SURVEY_TIP_NEIGHBORS = 2;
/** A surveyed tongue ends where its rings fan out this many times its narrowest. */
const SURVEY_FAN_OUT = 4;

/** A hostile player's salient into a nation, as a neck search found it. */
export interface Salient {
  /** The salient's owner. */
  owner: Player;
  /** The owner's tile the search grew from: the deepest it holds. */
  tip: TileRef;
  /** The neck: the ring that, once taken, cuts the tip side off. */
  neck: TileRef[];
  /** The owner's tiles past the neck, on the tip side. */
  cutOff: number;
}

/**
 * The tile a spear line's salient is searched from: the line's tip while
 * `owner` holds it, else the deepest tile of `owner`'s within a few tiles
 * of it (null when none is left).
 */
export function salientTip(
  game: Game,
  owner: Player,
  line: SpearLine,
): TileRef | null {
  const map = game.map();
  const own = owner.smallID();
  if (map.ownerID(line.tip) === own) return line.tip;
  const ox = map.x(line.origin);
  const oy = map.y(line.origin);
  const tx = map.x(line.tip);
  const ty = map.y(line.tip);
  const r = NATION_NECK_TIP_MARGIN * 2;
  let best: TileRef | null = null;
  let bestDepth = -1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if (!map.isValidCoord(x, y)) continue;
      const t = map.ref(x, y);
      if (map.ownerID(t) !== own) continue;
      const d = spearDepth(ox, oy, tx, ty, x, y);
      if (d > bestDepth) {
        best = t;
        bestDepth = d;
      }
    }
  }
  return bestDepth > SPEAR_FREE_DEPTH ? best : null;
}

/**
 * The salient of `owner`'s land into `nation` grown from `tip`, and its
 * neck, or null when there is none: the tip isn't `owner`'s, the land
 * before the main land is too short to have a neck past the tip's taper or
 * too big to judge, or the tip is already cut off. `line` is the spear line
 * that took it, which marks where the main land starts; null for a tongue
 * the survey found, which must also be walled in by `nation` alone and be
 * longer than SPEAR_FREE_DEPTH.
 */
export function findSalient(
  game: Game,
  nation: Player,
  owner: Player,
  tip: TileRef,
  line: SpearLine | null,
): Salient | null {
  const map = game.map();
  const own = owner.smallID();
  const ours = nation.smallID();
  if (map.ownerID(tip) !== own) return null;
  const ox = line === null ? 0 : map.x(line.origin);
  const oy = line === null ? 0 : map.y(line.origin);
  const tx = map.x(tip);
  const ty = map.y(tip);
  const nbuf: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];
  // Whether `t` lies in the owner's main land, past the salient.
  const mainLand = (t: TileRef): boolean => {
    if (line !== null) {
      return spearDepth(ox, oy, tx, ty, map.x(t), map.y(t)) <= SPEAR_FREE_DEPTH;
    }
    if (map.isOnEdgeOfMap(t)) return true;
    const n = map.neighbors4(t, nbuf);
    for (let i = 0; i < n; i++) {
      const nb = nbuf[i];
      if (!map.isLand(nb)) return true;
      const id = map.ownerID(nb);
      if (id !== own && id !== ours) return true;
    }
    return false;
  };
  const seen = new Set<TileRef>([tip]);
  const rings: TileRef[][] = [];
  let ring: TileRef[] = [tip];
  let grown = 0;
  let narrowest = Infinity;
  let reachedMain = false;
  while (ring.length > 0) {
    if (
      ring.some(mainLand) ||
      (line === null &&
        ring.length >= SURVEY_FAN_OUT * narrowest &&
        ring.length > 2 * NATION_NECK_TIP_MARGIN)
    ) {
      reachedMain = true;
      break;
    }
    narrowest = Math.min(narrowest, ring.length);
    rings.push(ring);
    grown += ring.length;
    if (grown > NATION_SALIENT_SEARCH_TILES) return null;
    const next: TileRef[] = [];
    for (const t of ring) {
      const n = map.neighbors8(t, nbuf);
      for (let i = 0; i < n; i++) {
        const nb = nbuf[i];
        if (seen.has(nb) || map.ownerID(nb) !== own || !map.isLand(nb)) {
          continue;
        }
        seen.add(nb);
        next.push(nb);
      }
    }
    ring = next;
  }
  // Grown out without reaching the main land: already a pocket.
  if (!reachedMain) return null;
  if (line === null && rings.length <= SPEAR_FREE_DEPTH) return null;
  if (rings.length <= NATION_NECK_TIP_MARGIN) return null;
  let best = NATION_NECK_TIP_MARGIN;
  for (let k = best + 1; k < rings.length; k++) {
    // The narrowest, and nearest the main land on a tie: it cuts off most.
    if (rings[k].length <= rings[best].length) best = k;
  }
  // A salient is longer than its neck is wide; a wide bulge is a front.
  if (rings[best].length > best) return null;
  let cutOff = 0;
  for (let k = 0; k < best; k++) cutOff += rings[k].length;
  return { owner, tip, neck: rings[best], cutOff };
}

/**
 * Salients of `owner` into `nation` the nation's own survey finds, without
 * a spear line: grown from up to SURVEY_SEEDS tip-like tiles of its front
 * (`frontTiles`, owner tiles across our border with at least
 * SURVEY_TIP_NEIGHBORS of their 4 neighbors ours), the first found.
 */
export function surveySalient(
  game: Game,
  nation: Player,
  owner: Player,
  frontTiles: readonly TileRef[],
): Salient | null {
  const map = game.map();
  const ours = nation.smallID();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  const tips: TileRef[] = [];
  for (const t of frontTiles) {
    const n = map.neighbors4(t, nbuf);
    let mine = 0;
    for (let i = 0; i < n; i++) if (map.ownerID(nbuf[i]) === ours) mine++;
    if (mine >= SURVEY_TIP_NEIGHBORS) tips.push(t);
  }
  const step = Math.max(1, Math.floor(tips.length / SURVEY_SEEDS));
  for (let i = 0; i < tips.length && i < step * SURVEY_SEEDS; i += step) {
    const salient = findSalient(game, nation, owner, tips[i], null);
    if (salient !== null) return salient;
  }
  return null;
}

/** The neck tiles that border `nation`'s land, where a cut can start. */
export function neckEnds(
  game: Game,
  nation: Player,
  neck: readonly TileRef[],
): TileRef[] {
  const map = game.map();
  const ours = nation.smallID();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  return neck.filter((t) => {
    const n = map.neighbors4(t, nbuf);
    for (let i = 0; i < n; i++) if (map.ownerID(nbuf[i]) === ours) return true;
    return false;
  });
}

/**
 * The two ends of a neck that borders `nation` on both sides: the pair of
 * its tiles bordering the nation furthest apart (manhattan), or null when
 * the nation borders it on one side only.
 */
export function neckSides(
  game: Game,
  nation: Player,
  neck: readonly TileRef[],
): [TileRef, TileRef] | null {
  const ends = neckEnds(game, nation, neck);
  let best: [TileRef, TileRef] | null = null;
  let bestDist = 1;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const d = game.manhattanDist(ends[i], ends[j]);
      if (d > bestDist) {
        best = [ends[i], ends[j]];
        bestDist = d;
      }
    }
  }
  return best;
}

/** The tile of `tiles` with the least total manhattan distance to the others. */
export function medoidTile(game: Game, tiles: readonly TileRef[]): TileRef {
  let best = tiles[0];
  let bestSum = Infinity;
  for (const a of tiles) {
    let sum = 0;
    for (const b of tiles) sum += game.manhattanDist(a, b);
    if (sum < bestSum) {
      best = a;
      bestSum = sum;
    }
  }
  return best;
}

/**
 * `owner`'s land around `tile` when it is cut off from the rest: the
 * 8-connected piece holding `tile`, if growing it stops (every tile found)
 * below half of `owner`'s land and NATION_SALIENT_SEARCH_TILES; else null.
 */
export function cutOffPiece(
  game: Game,
  owner: Player,
  tile: TileRef,
): TileRef[] | null {
  const map = game.map();
  const own = owner.smallID();
  if (map.ownerID(tile) !== own) return null;
  const limit = Math.min(
    NATION_SALIENT_SEARCH_TILES,
    Math.floor(owner.numTilesOwned() / 2),
  );
  const nbuf: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];
  const seen = new Set<TileRef>([tile]);
  const piece: TileRef[] = [tile];
  for (let i = 0; i < piece.length; i++) {
    if (piece.length > limit) return null;
    const n = map.neighbors8(piece[i], nbuf);
    for (let j = 0; j < n; j++) {
      const nb = nbuf[j];
      if (seen.has(nb) || map.ownerID(nb) !== own || !map.isLand(nb)) continue;
      seen.add(nb);
      piece.push(nb);
    }
  }
  return piece.length > limit ? null : piece;
}
