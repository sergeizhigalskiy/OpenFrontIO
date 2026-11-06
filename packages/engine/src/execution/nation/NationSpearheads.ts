import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { attackForecast } from "@openfront/engine-lib/game/AttackForecast";
import {
  DEFENSE_POST_RANGE,
  defensePostCovers,
} from "@openfront/engine-lib/game/DefensePosts";
import { Game, Player, Unit } from "../../game/Game";
import { Railroad } from "../../game/Railroad";
import { TrainStation } from "../../game/TrainStation";
import { pocketAnnexLimit } from "../PlayerExecution";

/**
 * How nations read a front and where they aim their spearheads, by
 * difficulty (the spec's difficulty ladder). Stateless and draws nothing
 * from the PRNG; NationAttackBehavior asks on its attack ticks.
 *
 * A front is the target's land across our border (surveyFronts).
 *
 * Targets are ranked weakest first by troops, as upstream does. The attack
 * forecast (engine-lib AttackForecast) decides where to strike and how much
 * to send: the spearheads below, the cheapest front tile, and the stack an
 * attack needs (NationAttackBehavior.worthwhileStack), which Medium prices
 * without terrain features (the ladder's "picks fronts with the forecast,
 * ignoring terrain").
 *
 * Weighing posts: Hard and Impossible rank a target as NATION_POST_FRONT_WEIGHT
 * times as strong when its defense posts cover more than half the front.
 *
 * Spearheads (spearheadFocus), first that applies:
 *  - Medium and up: the target's nearest defense post covering at least a
 *    quarter of the front (NATION_POST_FOCUS_SHARE);
 *  - Hard and up: a neck of at most NATION_NECK_MAX_TILES tiles that would
 *    cut off a pocket small enough to annex (PlayerExecution's
 *    pocketAnnexLimit); then the target's best city within
 *    NATION_CITY_FOCUS_RANGE tiles of the front; then an enemy rail within
 *    NATION_RAIL_FOCUS_RANGE tiles of the front (Impossible: the cut that
 *    splits the most stations off, railCutValue);
 *  - Impossible re-aims a stalled attack at the cheapest front tile
 *    (cheapestFrontTile; NationAttackBehavior watches for the stall).
 * Easy never spearheads a player.
 *
 * Rail cuts (railCutToRetake): Medium and up retake a cut tile of their own
 * rails first; Impossible picks the most valuable one.
 */

/** Hard and Impossible rank a target this many times as costly when its posts cover most of the front. */
export const NATION_POST_FRONT_WEIGHT = 2;
/** ...more than this share of the front. */
export const NATION_POST_FRONT_SHARE = 0.5;
/** Medium and up spearhead at a defense post covering at least this share of the front. */
export const NATION_POST_FOCUS_SHARE = 0.25;
/** Hard and up spearhead at a neck of at most this many tiles... */
export const NATION_NECK_MAX_TILES = 12;
/** ...at the target's best city within this many tiles (manhattan) of the front... */
export const NATION_CITY_FOCUS_RANGE = 40;
/** ...and at an enemy rail within this many tiles (manhattan) of the front. */
export const NATION_RAIL_FOCUS_RANGE = 30;
/**
 * The smallest stack worth sending at a player takes about this many tiles
 * at the forecast's loss per tile (NationAttackBehavior.worthwhileStack).
 */
export const NATION_ATTACK_FRONT_TILES = 150;

/** Distinct target tiles kept per front. */
const FRONT_SURVEY_MAX_TILES = 512;
/** Our border tiles scanned at most, so a huge border stays cheap. */
const FRONT_SURVEY_SCAN_BORDER_TILES = 4096;
/** Front tiles read for post cover and the cheapest tile. */
const FRONT_COVER_SAMPLE_TILES = 32;
/** Front tiles a neck search starts from. */
const NECK_SEARCH_SEEDS = 8;
/** Enemy rails weighed at most for their value (Impossible). */
const RAIL_VALUE_CANDIDATES = 8;
/** Stations a rail's value walks at most per side. */
const RAIL_VALUE_MAX_STATIONS = 512;
/** Bucket size (tiles) of a FrontIndex. */
const FRONT_INDEX_CELL = 16;

/** One front: `owner`'s land across our border. */
export interface FrontSurvey {
  /** The owner's small id. */
  owner: number;
  /** Distinct owner tiles across our border in discovery order (capped). */
  tiles: TileRef[];
}

/** A reusable tile set: each next() empties it (the simulation is single-threaded). */
class TileStamps {
  private stamps = new Uint32Array(0);
  private gen = 0;

  next(size: number): void {
    if (this.stamps.length !== size) {
      this.stamps = new Uint32Array(size);
      this.gen = 0;
    }
    if (this.gen >= 0xfffffffe) {
      this.stamps.fill(0);
      this.gen = 0;
    }
    this.gen++;
  }

  has(tile: TileRef): boolean {
    return this.stamps[tile] === this.gen;
  }

  add(tile: TileRef): void {
    this.stamps[tile] = this.gen;
  }
}
const seenScratch = new TileStamps();
const exploredScratch = new TileStamps();

/**
 * Every player front of `player`, by the owner's small id: the land of each
 * player across its border (free land is no front here).
 */
export function surveyFronts(
  game: Game,
  player: Player,
): Map<number, FrontSurvey> {
  const map = game.map();
  const own = player.smallID();
  const seen = seenScratch;
  seen.next(map.width() * map.height());
  const out = new Map<number, FrontSurvey>();
  const nbuf: TileRef[] = [0, 0, 0, 0];
  let scanned = 0;
  for (const border of player.borderTiles()) {
    if (++scanned > FRONT_SURVEY_SCAN_BORDER_TILES) break;
    const n = map.neighbors4(border, nbuf);
    for (let i = 0; i < n; i++) {
      const t = nbuf[i];
      const owner = map.ownerID(t);
      if (owner === own || owner === 0 || seen.has(t)) continue;
      if (!map.isLand(t) || map.isImpassable(t)) continue;
      seen.add(t);
      let front = out.get(owner);
      if (front === undefined) {
        front = { owner, tiles: [] };
        out.set(owner, front);
      }
      if (front.tiles.length < FRONT_SURVEY_MAX_TILES) front.tiles.push(t);
    }
  }
  return out;
}

/** Up to `n` of `tiles`, evenly spaced. */
export function sampleTiles(tiles: readonly TileRef[], n: number): TileRef[] {
  if (tiles.length <= n) return tiles.slice();
  const out: TileRef[] = [];
  for (let i = 0; i < n; i++) {
    out.push(tiles[Math.floor((i * tiles.length) / n)]);
  }
  return out;
}

function builtUnits(player: Player, type: UnitType): Unit[] {
  return player.units(type).filter((u) => !u.isUnderConstruction());
}

/** Whether `target`'s defense posts cover more than NATION_POST_FRONT_SHARE of the front. */
export function postsCoverFront(
  game: Game,
  target: Player,
  front: FrontSurvey | undefined,
): boolean {
  if (front === undefined || front.tiles.length === 0) return false;
  if (target.units(UnitType.DefensePost).length === 0) return false;
  const tiles = sampleTiles(front.tiles, FRONT_COVER_SAMPLE_TILES);
  let covered = 0;
  for (const t of tiles) {
    if (defensePostCovers(game, t, target.smallID())) covered++;
  }
  return covered > tiles.length * NATION_POST_FRONT_SHARE;
}

/**
 * Where `player` spearheads an attack on `target` across `front`, by
 * difficulty (see the top of this file), or null for a broad push.
 */
export function spearheadFocus(
  game: Game,
  player: Player,
  target: Player,
  front: FrontSurvey | undefined,
  difficulty: Difficulty,
): TileRef | null {
  if (difficulty === Difficulty.Easy) return null;
  if (front === undefined || front.tiles.length === 0) return null;
  const index = new FrontIndex(game, front.tiles);
  const post = postFocus(game, target, front, index);
  if (post !== null || difficulty === Difficulty.Medium) return post;
  return (
    neckFocus(game, player, target, front) ??
    cityFocus(game, target, index) ??
    railFocus(game, target, index, difficulty === Difficulty.Impossible)
  );
}

/** The target's built post nearest the front among those covering at least NATION_POST_FOCUS_SHARE of it. */
export function postFocus(
  game: Game,
  target: Player,
  front: FrontSurvey,
  index: FrontIndex = new FrontIndex(game, front.tiles),
): TileRef | null {
  const posts = builtUnits(target, UnitType.DefensePost);
  if (posts.length === 0) return null;
  const tiles = sampleTiles(front.tiles, FRONT_COVER_SAMPLE_TILES);
  const range2 = DEFENSE_POST_RANGE * DEFENSE_POST_RANGE;
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const post of posts) {
    let covered = 0;
    for (const t of tiles) {
      if (game.euclideanDistSquared(post.tile(), t) <= range2) covered++;
    }
    if (covered < tiles.length * NATION_POST_FOCUS_SHARE) continue;
    const dist = index.distance(post.tile(), Infinity);
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && post.id() < best.id())
    ) {
      best = post;
      bestDist = dist;
    }
  }
  return best?.tile() ?? null;
}

/**
 * A neck of `target`'s land of at most NATION_NECK_MAX_TILES tiles that, once
 * `player` takes it, cuts off a pocket next to `player` small enough to be
 * annexed (pocketAnnexLimit) and walled in by `player` alone (no coast, map
 * edge, free land or third player around it), while the target keeps more
 * land than the pocket. Returns the neck's middle tile, or null.
 *
 * Grows the target's land breadth-first from front tiles: after each ring,
 * the next ring is exactly the target land bordering what was grown, so a
 * small next ring is a neck. It must be narrower than the pocket is deep
 * (rings grown), or any stretch of front would be one: the first few rings
 * from a straight border are small too.
 */
export function neckFocus(
  game: Game,
  player: Player,
  target: Player,
  front: FrontSurvey,
): TileRef | null {
  const map = game.map();
  const own = player.smallID();
  const theirs = target.smallID();
  const total = target.numTilesOwned();
  const limit = pocketAnnexLimit(total);
  const size = map.width() * map.height();
  const seen = seenScratch;
  const explored = exploredScratch;
  explored.next(size);
  const nbuf: TileRef[] = [0, 0, 0, 0];
  for (const seed of sampleTiles(front.tiles, NECK_SEARCH_SEEDS)) {
    // A seed an earlier search grew over would find the same land.
    if (explored.has(seed) || map.ownerID(seed) !== theirs) continue;
    seen.next(size);
    seen.add(seed);
    explored.add(seed);
    let ring: TileRef[] = [seed];
    let grown = 0;
    let depth = 0;
    let walled = true;
    while (walled && ring.length > 0) {
      // `ring` joins the pocket: it must border only the target and us.
      const next: TileRef[] = [];
      for (const t of ring) {
        if (map.isShore(t) || map.isOnEdgeOfMap(t)) {
          walled = false;
          break;
        }
        const n = map.neighbors4(t, nbuf);
        for (let i = 0; i < n; i++) {
          const nb = nbuf[i];
          const owner = map.ownerID(nb);
          if (owner === own) continue;
          if (owner !== theirs || !map.isLand(nb)) {
            walled = false;
            break;
          }
          if (seen.has(nb)) continue;
          seen.add(nb);
          explored.add(nb);
          next.push(nb);
        }
        if (!walled) break;
      }
      if (!walled) break;
      grown += ring.length;
      depth++;
      if (grown > limit) break;
      if (
        next.length > 0 &&
        next.length <= NATION_NECK_MAX_TILES &&
        next.length < depth &&
        total - grown - next.length > grown
      ) {
        return medoid(game, next);
      }
      ring = next;
    }
  }
  return null;
}

/** The tile of `tiles` with the least total manhattan distance to the others. */
function medoid(game: Game, tiles: readonly TileRef[]): TileRef {
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

/** The target's best city (highest level, then nearest, then oldest) within NATION_CITY_FOCUS_RANGE of the front. */
export function cityFocus(
  game: Game,
  target: Player,
  index: FrontIndex,
): TileRef | null {
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const city of builtUnits(target, UnitType.City)) {
    if (game.ownerID(city.tile()) !== target.smallID()) continue;
    const dist = index.distance(city.tile(), NATION_CITY_FOCUS_RANGE);
    if (dist > NATION_CITY_FOCUS_RANGE) continue;
    if (
      best === null ||
      city.level() > best.level() ||
      (city.level() === best.level() &&
        (dist < bestDist || (dist === bestDist && city.id() < best.id())))
    ) {
      best = city;
      bestDist = dist;
    }
  }
  return best?.tile() ?? null;
}

/** Units that can hold a train station. */
const STATION_TYPES: readonly UnitType[] = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
];

function stationOf(game: Game, unit: Unit): TrainStation | null {
  return game.railNetwork().stationManager().findStation(unit);
}

/** Every railroad with a station of `player` at an end, once each, in station order. */
function railsOf(game: Game, player: Player): Railroad[] {
  const seen = new Set<number>();
  const out: Railroad[] = [];
  for (const unit of player.units(STATION_TYPES)) {
    const station = stationOf(game, unit);
    if (station === null) continue;
    for (const rail of station.getRailroads()) {
      if (seen.has(rail.id)) continue;
      seen.add(rail.id);
      out.push(rail);
    }
  }
  return out;
}

/**
 * A tile of one of `target`'s live rails, on its land within
 * NATION_RAIL_FOCUS_RANGE of the front: the nearest, or for Impossible
 * (`byValue`) the one on the rail whose cut splits the most stations off
 * (railCutValue), then the nearest.
 */
export function railFocus(
  game: Game,
  target: Player,
  index: FrontIndex,
  byValue: boolean,
): TileRef | null {
  if (index.empty()) return null;
  const theirs = target.smallID();
  const box = index.box(NATION_RAIL_FOCUS_RANGE);
  const candidates: { rail: Railroad; tile: TileRef; dist: number }[] = [];
  for (const rail of railsOf(game, target)) {
    if (rail.isCut()) continue;
    let bestTile = -1;
    let bestDist = Infinity;
    for (const t of rail.tiles) {
      const x = game.x(t);
      const y = game.y(t);
      if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) {
        continue;
      }
      if (game.ownerID(t) !== theirs) continue;
      const dist = index.distance(t, NATION_RAIL_FOCUS_RANGE);
      if (dist < bestDist) {
        bestDist = dist;
        bestTile = t;
      }
    }
    if (bestTile >= 0 && bestDist <= NATION_RAIL_FOCUS_RANGE) {
      candidates.push({ rail, tile: bestTile, dist: bestDist });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.dist - b.dist || a.rail.id - b.rail.id);
  if (!byValue) return candidates[0].tile;
  let best = candidates[0];
  let bestValue = -1;
  for (const c of candidates.slice(0, RAIL_VALUE_CANDIDATES)) {
    const value = railCutValue(c.rail);
    if (value > bestValue) {
      best = c;
      bestValue = value;
    }
  }
  return best.tile;
}

/**
 * What cutting `rail` splits off: the trade stations (cities and ports) on
 * the smaller side of its network without it, or 0 when another route still
 * joins its ends. Walks live rails only, at most RAIL_VALUE_MAX_STATIONS a
 * side.
 */
export function railCutValue(rail: Railroad): number {
  const side = (start: TrainStation, other: TrainStation): number | null => {
    const seen = new Set<TrainStation>([start]);
    const queue: TrainStation[] = [start];
    let trade = 0;
    for (let i = 0; i < queue.length; i++) {
      const s = queue[i];
      const type = s.unit.type();
      if (type === UnitType.City || type === UnitType.Port) trade++;
      if (seen.size > RAIL_VALUE_MAX_STATIONS) continue;
      for (const r of s.getRailroads()) {
        if (r === rail || r.isCut()) continue;
        const next = r.from === s ? r.to : r.from;
        if (next === other) return null;
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return trade;
  };
  const a = side(rail.from, rail.to);
  if (a === null) return 0;
  const b = side(rail.to, rail.from);
  if (b === null) return 0;
  return Math.min(a, b);
}

/** A cut tile of one of `player`'s rails, held by a hostile player it borders by land. */
export interface RailCut {
  rail: Railroad;
  tile: TileRef;
  holder: Player;
}

/**
 * The cut tile `player` retakes first (Medium and up): on one of its own
 * rails, held by a non-friendly player it borders by land. The first one in
 * station order, or for Impossible (`byValue`) the one on the rail whose
 * repair joins the most stations back (railCutValue).
 */
export function railCutToRetake(
  game: Game,
  player: Player,
  byValue: boolean,
): RailCut | null {
  let best: RailCut | null = null;
  let bestValue = -1;
  for (const rail of railsOf(game, player)) {
    for (const tile of rail.cutTiles) {
      const holder = game.owner(tile);
      if (
        !holder.isPlayer() ||
        holder === player ||
        player.isFriendly(holder) ||
        !player.sharesBorderWith(holder)
      ) {
        continue;
      }
      if (!byValue) return { rail, tile, holder };
      const value = railCutValue(rail);
      if (value > bestValue) {
        best = { rail, tile, holder };
        bestValue = value;
      }
      break;
    }
  }
  return best;
}

/**
 * The front tile where an attack on `target` with `troops` loses the fewest
 * troops per tile by the full forecast, spearheaded (lowest tile on a tie):
 * where Impossible re-aims a stalled attack.
 */
export function cheapestFrontTile(
  game: Game,
  player: Player,
  target: Player,
  front: FrontSurvey | undefined,
  troops: number,
): TileRef | null {
  if (front === undefined || front.tiles.length === 0) return null;
  let best: TileRef | null = null;
  let bestLoss = Infinity;
  for (const tile of sampleTiles(front.tiles, FRONT_COVER_SAMPLE_TILES)) {
    const loss = attackForecast(
      game,
      player,
      target,
      tile,
      troops,
      front.tiles.length,
      true,
    ).lossPerTile;
    if (
      loss < bestLoss ||
      (loss === bestLoss && best !== null && tile < best)
    ) {
      best = tile;
      bestLoss = loss;
    }
  }
  return best;
}

/** Front tiles bucketed for "how far is the front" questions. */
export class FrontIndex {
  private buckets = new Map<number, TileRef[]>();
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  constructor(
    private game: Game,
    tiles: readonly TileRef[],
  ) {
    for (const t of tiles) {
      const x = game.x(t);
      const y = game.y(t);
      this.minX = Math.min(this.minX, x);
      this.minY = Math.min(this.minY, y);
      this.maxX = Math.max(this.maxX, x);
      this.maxY = Math.max(this.maxY, y);
      const key = this.key(
        Math.floor(x / FRONT_INDEX_CELL),
        Math.floor(y / FRONT_INDEX_CELL),
      );
      let bucket = this.buckets.get(key);
      if (bucket === undefined) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(t);
    }
  }

  // Cells reach a few past the map's edges, so offset them to stay positive.
  private key(cx: number, cy: number): number {
    return (cx + 64) * 65536 + (cy + 64);
  }

  empty(): boolean {
    return this.buckets.size === 0;
  }

  /** The front's bounding box grown by `margin` tiles. */
  box(margin: number): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } {
    return {
      minX: this.minX - margin,
      minY: this.minY - margin,
      maxX: this.maxX + margin,
      maxY: this.maxY + margin,
    };
  }

  /** Fewest manhattan tiles from `tile` to the front, when at most `max`; else Infinity. */
  distance(tile: TileRef, max: number): number {
    if (this.buckets.size === 0) return Infinity;
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    let best = Infinity;
    if (!Number.isFinite(max)) {
      for (const bucket of this.buckets.values()) {
        for (const t of bucket) {
          best = Math.min(best, this.game.manhattanDist(tile, t));
        }
      }
      return best;
    }
    const cx = Math.floor(x / FRONT_INDEX_CELL);
    const cy = Math.floor(y / FRONT_INDEX_CELL);
    const reach = Math.ceil(max / FRONT_INDEX_CELL);
    for (let i = cx - reach; i <= cx + reach; i++) {
      for (let j = cy - reach; j <= cy + reach; j++) {
        const bucket = this.buckets.get(this.key(i, j));
        if (bucket === undefined) continue;
        for (const t of bucket) {
          const d = this.game.manhattanDist(tile, t);
          if (d < best) best = d;
        }
      }
    }
    return best <= max ? best : Infinity;
  }
}
