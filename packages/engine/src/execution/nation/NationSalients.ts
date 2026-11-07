import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Game, Player } from "../../game/Game";

/**
 * Salients: land a hostile player pushed deep into a nation, and the neck
 * the nation cuts it at (NationAttackBehavior.answerSalient, Medium and up).
 * Stateless and draws nothing from the PRNG.
 *
 * A salient is a tongue of the player's land, walled in by the nation
 * alone, whose neck lies NATION_SALIENT_MIN_RINGS or more from its tip, that
 * the nation's survey of its front finds (surveySalient).
 *
 * The neck is the narrowest cross-section between the tip and the player's
 * main land, and narrower than it lies from the tip: a wider one makes the
 * land a front, not a salient. Cross-sections are the rings of a
 * breadth-first growth of the player's land from the tip, 8-connected:
 * every path of its land from the tip to its main land crosses each ring,
 * so taking one ring cuts off all the land before it. The rings stop at the
 * main land: the first ring that touches anything but the two players' land
 * (a third player, free land, water or the map edge), or once
 * NATION_SALIENT_SEARCH_TILES are grown.
 */

/** Tiles a neck search grows at most; past them lies the main land. */
export const NATION_SALIENT_SEARCH_TILES = 4096;
/**
 * A salient's neck lies at least this many rings from where the search
 * starts: deeper than a spearhead's bulge can be (SPEAR_TIP_LEAD).
 */
export const NATION_SALIENT_MIN_RINGS = 16;
/** Tip-like front tiles a survey grows from, per player. */
const SURVEY_SEEDS = 4;
/** A front tile is tip-like (a corner) when this many of its 4 neighbors are ours. */
const SURVEY_TIP_NEIGHBORS = 2;
/** Half-width of the square a tip-like tile's pointedness is counted in. */
const SURVEY_TIP_WINDOW = 3;

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
 * The salient of `owner`'s land into `nation` grown from `tip`, and its
 * neck, or null when there is none: the tip isn't `owner`'s, no ring
 * NATION_SALIENT_MIN_RINGS or more from it is a neck walled in by `nation`
 * alone, or the tip is already cut off.
 */
export function findSalient(
  game: Game,
  nation: Player,
  owner: Player,
  tip: TileRef,
): Salient | null {
  const map = game.map();
  const own = owner.smallID();
  const ours = nation.smallID();
  if (map.ownerID(tip) !== own) return null;
  const nbuf: TileRef[] = [0, 0, 0, 0, 0, 0, 0, 0];
  // Whether `t` touches anything but the two players' land: past the tongue.
  const mainLand = (t: TileRef): boolean => {
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
  let reachedMain = false;
  while (ring.length > 0) {
    if (ring.some(mainLand)) {
      reachedMain = true;
      break;
    }
    rings.push(ring);
    grown += ring.length;
    // Grown this far, the rest is the owner's main land.
    if (grown > NATION_SALIENT_SEARCH_TILES) {
      reachedMain = true;
      break;
    }
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
  if (rings.length <= NATION_SALIENT_MIN_RINGS) return null;
  let best = NATION_SALIENT_MIN_RINGS;
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
 * A salient of `owner` into `nation` the nation's survey finds: grown from
 * the SURVEY_SEEDS most pointed tip-like tiles of its front (`frontTiles`,
 * owner tiles across our border with at least SURVEY_TIP_NEIGHBORS of their
 * 4 neighbors ours; pointed: the fewest of the owner's tiles within
 * SURVEY_TIP_WINDOW, as at a tongue's tip, not at the corners where it
 * leaves its main land), the one with the narrowest neck.
 */
export function surveySalient(
  game: Game,
  nation: Player,
  owner: Player,
  frontTiles: readonly TileRef[],
): Salient | null {
  const map = game.map();
  const own = owner.smallID();
  const ours = nation.smallID();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  const tips: { tile: TileRef; owned: number }[] = [];
  for (const t of frontTiles) {
    const n = map.neighbors4(t, nbuf);
    let mine = 0;
    for (let i = 0; i < n; i++) if (map.ownerID(nbuf[i]) === ours) mine++;
    if (mine < SURVEY_TIP_NEIGHBORS) continue;
    const x = map.x(t);
    const y = map.y(t);
    let owned = 0;
    for (let dy = -SURVEY_TIP_WINDOW; dy <= SURVEY_TIP_WINDOW; dy++) {
      for (let dx = -SURVEY_TIP_WINDOW; dx <= SURVEY_TIP_WINDOW; dx++) {
        if (!map.isValidCoord(x + dx, y + dy)) continue;
        if (map.ownerID(map.ref(x + dx, y + dy)) === own) owned++;
      }
    }
    tips.push({ tile: t, owned });
  }
  // Stable: ties keep the front's order.
  tips.sort((a, b) => a.owned - b.owned);
  let best: Salient | null = null;
  for (let i = 0; i < tips.length && i < SURVEY_SEEDS; i++) {
    const salient = findSalient(game, nation, owner, tips[i].tile);
    if (
      salient !== null &&
      (best === null ||
        salient.neck.length < best.neck.length ||
        (salient.neck.length === best.neck.length &&
          salient.cutOff > best.cutOff))
    ) {
      best = salient;
    }
  }
  return best;
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
