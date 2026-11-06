import type { ConvoyRouteForecast } from "@openfront/engine-api/game/ConvoyForecast";
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  chooseConvoyRoute,
  CONVOY_COST_HOSTILE_LAND,
  CONVOY_COST_SAFE_LAND,
  CONVOY_COST_WATER,
  CONVOY_MAX_WATER_CROSSING,
  CONVOY_SHELL_STEP,
  convoyAmbushDensityLoss,
  isConvoyHostileTo,
} from "@openfront/engine-lib/game/Convoys";
import { Game, Player } from "../game/Game";
import { AStar, AStarAdapter } from "../pathfinding/algorithms/AStar";
import { PathFinding } from "../pathfinding/PathFinder";
import { SpatialQuery } from "../pathfinding/spatial/SpatialQuery";

/**
 * Where a troop convoy goes. It leaves from the sender's border tile nearest
 * the middle of the recipient's land and is planned two ways:
 *
 * - Overland: the cheapest path by the tile costs in engine-lib Convoys.ts
 *   (safe land 1, a water crossing of up to CONVOY_MAX_WATER_CROSSING tiles 2
 *   a tile, hostile land 4, city-state land never).
 * - By sea, like a transport ship: from a sender shore to a recipient shore.
 *
 * It takes whichever loses fewer troops (chooseConvoyRoute), pricing the
 * ambushes on the way and the hostile defense posts and warships in reach of
 * it at the moment it leaves. The donate panel shows the same options.
 */

/** A route the convoy could take: its tiles, first to last, and its forecast. */
export interface ConvoyRouteOption extends ConvoyRouteForecast {
  tiles: TileRef[];
}

/** The ways a convoy from `sender` to `recipient` could go: overland first. */
export function convoyRouteOptions(
  game: Game,
  sender: Player,
  recipient: Player,
): ConvoyRouteOption[] {
  const anchor = anchorTile(game, recipient);
  if (anchor === null) return [];
  const isLandTile = (t: TileRef) => game.isLand(t) && !game.isImpassable(t);
  const start = nearestTile(game, sender.borderTiles(), anchor, isLandTile);
  if (start === null) return [];
  const end = nearestTile(game, recipient.borderTiles(), start, isLandTile);
  if (end === null) return [];

  const options: ConvoyRouteOption[] = [];
  const land = convoyLandSearch(game).findRoute(sender, recipient, start, end);
  if (land !== null) {
    options.push(summarizeRoute(game, sender, recipient, land, "land"));
  }
  const sea = seaRoute(game, sender, recipient, start);
  if (sea !== null) {
    options.push(summarizeRoute(game, sender, recipient, sea, "sea"));
  }
  return options;
}

/**
 * The route a convoy of `troops` from `sender` to `recipient` takes, first
 * tile to last, or null when neither a land nor a sea route reaches the
 * recipient (say, an overseas ally with no shore on a sea the sender touches).
 */
export function planConvoyRoute(
  game: Game,
  sender: Player,
  recipient: Player,
  troops: number,
): TileRef[] | null {
  const options = convoyRouteOptions(game, sender, recipient);
  return chooseConvoyRoute(troops, options)?.tiles ?? null;
}

/**
 * What a convoy along `tiles` meets, by the rules ConvoyExecution applies:
 * it delivers on the first recipient tile (or the last tile), each hostile
 * land tile before that ambushes it, and each hostile defense post or warship
 * that can reach it on the way shells it once.
 */
export function summarizeRoute(
  game: Game,
  sender: Player,
  recipient: Player,
  tiles: TileRef[],
  mode: ConvoyRouteForecast["mode"],
): ConvoyRouteOption {
  let end = tiles.length - 1;
  for (let i = 1; i < tiles.length; i++) {
    if (game.owner(tiles[i]) === recipient) {
      end = i;
      break;
    }
  }
  const shells = shellIndices(game, sender, recipient, tiles, end);
  const steps: number[] = [];
  const crossed: Player[] = [];
  let hostileTiles = 0;
  let nextShell = 0;
  for (let i = 0; i < end; i++) {
    const tile = tiles[i];
    if (i > 0 && game.isLand(tile)) {
      const owner = game.owner(tile);
      if (owner.isPlayer() && isConvoyHostileTo(sender, recipient, owner)) {
        hostileTiles++;
        steps.push(
          convoyAmbushDensityLoss(owner.troops(), owner.numTilesOwned()),
        );
        if (!crossed.includes(owner)) crossed.push(owner);
      }
    }
    while (nextShell < shells.length && shells[nextShell] === i) {
      steps.push(CONVOY_SHELL_STEP);
      nextShell++;
    }
  }
  return {
    mode,
    length: end,
    hostileTiles,
    shells: shells.length,
    steps,
    crossed: crossed.map((p) => p.id()),
    tiles,
  };
}

/**
 * For each hostile defense post and warship that can shell a convoy along
 * `tiles` before it delivers at `end`, the first route index in its reach,
 * sorted. A post reaches by its range, a warship only tiles at sea.
 */
function shellIndices(
  game: Game,
  sender: Player,
  recipient: Player,
  tiles: TileRef[],
  end: number,
): number[] {
  const indices: number[] = [];
  for (const post of game.units(UnitType.DefensePost)) {
    if (!post.isActive() || post.isUnderConstruction()) continue;
    if (!isConvoyHostileTo(sender, recipient, post.owner())) continue;
    const range = game.config().defensePostRange();
    const i = firstInReach(game, tiles, end, post.tile(), range, false);
    if (i >= 0) indices.push(i);
  }
  const shipRange = game.config().warshipTargettingRange();
  for (const ship of game.units(UnitType.Warship)) {
    if (!ship.isActive()) continue;
    if (ship.warshipState().state === "docked") continue;
    const owner = ship.owner();
    if (!owner.canAttackPlayer(sender, true)) continue;
    if (!isConvoyHostileTo(sender, recipient, owner)) continue;
    const i = firstInReach(game, tiles, end, ship.tile(), shipRange, true);
    if (i >= 0) indices.push(i);
  }
  return indices.sort((a, b) => a - b);
}

function firstInReach(
  game: Game,
  tiles: TileRef[],
  end: number,
  from: TileRef,
  range: number,
  atSeaOnly: boolean,
): number {
  const rangeSquared = range * range;
  for (let i = 0; i < end; i++) {
    const tile = tiles[i];
    if (atSeaOnly && !game.isWater(tile)) continue;
    if (game.euclideanDistSquared(from, tile) <= rangeSquared) return i;
  }
  return -1;
}

/** By sea, like a transport ship: from a sender shore to a recipient shore. */
function seaRoute(
  game: Game,
  sender: Player,
  recipient: Player,
  from: TileRef,
): TileRef[] | null {
  const seas = new Set<number>();
  sender.borderTiles().forEach((t) => {
    if (!game.isShore(t) || !game.isLand(t)) return;
    const component = game.getWaterComponent(t);
    if (component !== null) seas.add(component);
  });
  if (seas.size === 0) return null;

  const landing = nearestTile(game, recipient.borderTiles(), from, (t) => {
    if (!game.isShore(t) || !game.isLand(t)) return false;
    const component = game.getWaterComponent(t);
    return component !== null && seas.has(component);
  });
  if (landing === null) return null;

  const launch = new SpatialQuery(game).closestShoreByWater(sender, landing);
  if (launch === null) return null;

  const path = PathFinding.Water(game).findPath(launch, landing);
  if (path === null || path.length === 0) return null;
  return withEndpoints(path, launch, landing);
}

function withEndpoints(
  path: TileRef[],
  start: TileRef,
  end: TileRef,
): TileRef[] {
  const route = path[0] === start ? [...path] : [start, ...path];
  if (route[route.length - 1] !== end) route.push(end);
  return route;
}

/** A tile in the middle of `player`'s land, to aim convoys at. */
function anchorTile(game: Game, player: Player): TileRef | null {
  // Unset (undefined) until PlayerExecution first measures the player.
  const box = player.largestClusterBoundingBox;
  if (box) {
    const x = Math.floor((box.min.x + box.max.x) / 2);
    const y = Math.floor((box.min.y + box.max.y) / 2);
    if (game.isValidCoord(x, y)) return game.ref(x, y);
  }
  const spawn = player.spawnTile();
  if (spawn !== undefined) return spawn;
  for (const tile of player.borderTiles()) return tile;
  return null;
}

/** The tile of `tiles` nearest `target` that passes `accept` (first wins ties). */
function nearestTile(
  game: Game,
  tiles: Iterable<TileRef>,
  target: TileRef,
  accept: (t: TileRef) => boolean,
): TileRef | null {
  let best: TileRef | null = null;
  let bestDist = Infinity;
  for (const tile of tiles) {
    if (!accept(tile)) continue;
    const dist = game.manhattanDist(tile, target);
    if (dist < bestDist) {
      best = tile;
      bestDist = dist;
      if (dist === 0) break;
    }
  }
  return best;
}

// --- The overland search -----------------------------------------------------

/** Tiles one lattice edge may walk: a full crossing plus the land after it. */
const MAX_EDGE_TILES = 2 * (CONVOY_MAX_WATER_CROSSING + 1);

/** Lattice directions, in the order neighbors are listed: E, W, S, N. */
const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Cost marker for a tile a convoy never enters. */
const BLOCKED = -1;

/**
 * The cheapest overland convoy path, searched on a lattice of every second
 * tile in each direction (like the rail pathfinder's half-resolution
 * minimap) with A*. An edge between neighbouring lattice tiles costs the
 * tiles it walks through, so the cost of a path is exactly the cost of the
 * tiles the convoy enters. Where the next lattice tile is across water, the
 * edge runs straight on over at most CONVOY_MAX_WATER_CROSSING water tiles
 * to the first lattice tile on land beyond.
 *
 * One per game (convoyLandSearch): its scratch is sized to the lattice. It
 * keeps nothing between searches that changes a result.
 */
class ConvoyLandSearch implements AStarAdapter {
  private readonly width: number;
  private readonly height: number;
  /** Lattice columns and rows. */
  private readonly cols: number;
  private readonly rows: number;
  private readonly aStar: AStar;

  private sender: Player | null = null;
  private recipient: Player | null = null;
  /** Route cost of entering each owner's land, by small id, this search. */
  private readonly ownerCost = new Map<number, number>();

  // The edges the last neighbors() call listed, for cost().
  private edgeFrom = -1;
  private edgeCount = 0;
  private readonly edgeTo = new Int32Array(DIRECTIONS.length);
  private readonly edgeCost = new Int32Array(DIRECTIONS.length);
  private walkTo = -1;

  constructor(private readonly game: Game) {
    this.width = game.width();
    this.height = game.height();
    this.cols = (this.width + 1) >> 1;
    this.rows = (this.height + 1) >> 1;
    this.aStar = new AStar({
      adapter: this,
      maxIterations: 4 * this.cols * this.rows + 16,
    });
  }

  /** The tiles from `start` to `end`, or null when no overland path exists. */
  findRoute(
    sender: Player,
    recipient: Player,
    start: TileRef,
    end: TileRef,
  ): TileRef[] | null {
    this.sender = sender;
    this.recipient = recipient;
    this.ownerCost.clear();
    this.edgeFrom = -1;
    try {
      const starts = this.latticeLinks(start);
      const goal = this.latticeLinks(end)[0];
      if (starts.length === 0 || goal === undefined) return null;
      const nodes = this.aStar.findPath(
        starts.map((link) => link.node),
        goal.node,
      );
      if (nodes === null || nodes.length === 0) return null;
      const first = starts.find((link) => link.node === nodes[0]);
      if (first === undefined) return null;

      const tiles: TileRef[] = [start, ...first.tiles];
      for (let i = 1; i < nodes.length; i++) {
        this.appendEdge(tiles, nodes[i - 1], nodes[i]);
      }
      // The goal link runs from `end` to the lattice: walk it backwards.
      for (let i = goal.tiles.length - 2; i >= 0; i--) {
        tiles.push(goal.tiles[i]);
      }
      if (tiles[tiles.length - 1] !== end) tiles.push(end);
      return tiles;
    } finally {
      this.sender = null;
      this.recipient = null;
      this.ownerCost.clear();
    }
  }

  numNodes(): number {
    return this.cols * this.rows;
  }

  maxNeighbors(): number {
    return DIRECTIONS.length;
  }

  maxPriority(): number {
    // Higher priorities share the last bucket: still a valid path, just
    // explored in a looser order.
    return CONVOY_COST_HOSTILE_LAND * 2 * (this.width + this.height);
  }

  neighbors(node: number, buffer: Int32Array): number {
    const x = (node % this.cols) * 2;
    const y = Math.floor(node / this.cols) * 2;
    let count = 0;
    for (const [dx, dy] of DIRECTIONS) {
      const cost = this.walk(x, y, dx, dy);
      if (cost === BLOCKED) continue;
      buffer[count] = this.walkTo;
      this.edgeTo[count] = this.walkTo;
      this.edgeCost[count] = cost;
      count++;
    }
    this.edgeFrom = node;
    this.edgeCount = count;
    return count;
  }

  cost(from: number, to: number): number {
    if (from === this.edgeFrom) {
      for (let i = 0; i < this.edgeCount; i++) {
        if (this.edgeTo[i] === to) return this.edgeCost[i];
      }
    }
    // Not from the last neighbors() call: walk the edge again.
    const fx = (from % this.cols) * 2;
    const fy = Math.floor(from / this.cols) * 2;
    const tx = (to % this.cols) * 2;
    const ty = Math.floor(to / this.cols) * 2;
    const cost = this.walk(fx, fy, Math.sign(tx - fx), Math.sign(ty - fy));
    return cost === BLOCKED ? CONVOY_COST_HOSTILE_LAND * MAX_EDGE_TILES : cost;
  }

  heuristic(node: number, goal: number): number {
    // Every tile costs at least CONVOY_COST_SAFE_LAND, so this never
    // overestimates and the path found is the cheapest.
    const dx = Math.abs((node % this.cols) - (goal % this.cols));
    const dy = Math.abs(
      Math.floor(node / this.cols) - Math.floor(goal / this.cols),
    );
    return 2 * (dx + dy) * CONVOY_COST_SAFE_LAND;
  }

  /**
   * The cost of the edge from lattice tile (x, y) in direction (dx, dy),
   * setting walkTo to the lattice node it reaches, or BLOCKED.
   */
  private walk(x: number, y: number, dx: number, dy: number): number {
    const game = this.game;
    let cost = 0;
    let water = 0;
    for (let j = 1; j <= MAX_EDGE_TILES; j++) {
      const nx = x + dx * j;
      const ny = y + dy * j;
      if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) {
        return BLOCKED;
      }
      const tile = game.ref(nx, ny);
      if (!game.isLand(tile)) {
        if (++water > CONVOY_MAX_WATER_CROSSING) return BLOCKED;
        cost += CONVOY_COST_WATER;
        continue;
      }
      const landCost = this.landCost(tile);
      if (landCost === BLOCKED) return BLOCKED;
      cost += landCost;
      if ((j & 1) === 0) {
        this.walkTo = (ny >> 1) * this.cols + (nx >> 1);
        return cost;
      }
    }
    return BLOCKED;
  }

  /** The route cost of entering land `tile`, or BLOCKED. */
  private landCost(tile: TileRef): number {
    if (this.game.isImpassable(tile)) return BLOCKED;
    const owner = this.game.owner(tile);
    if (!owner.isPlayer()) return CONVOY_COST_SAFE_LAND;
    const id = owner.smallID();
    let cost = this.ownerCost.get(id);
    if (cost === undefined) {
      cost = owner.isCityState()
        ? BLOCKED
        : isConvoyHostileTo(this.sender!, this.recipient, owner)
          ? CONVOY_COST_HOSTILE_LAND
          : CONVOY_COST_SAFE_LAND;
      this.ownerCost.set(id, cost);
    }
    return cost;
  }

  /**
   * The lattice nodes next to `tile` it can step onto over land (horizontal
   * step first), each with the tiles after `tile` up to and including the
   * node's. A lattice tile links to itself with no tiles.
   */
  private latticeLinks(tile: TileRef): { node: number; tiles: TileRef[] }[] {
    const game = this.game;
    const x = game.x(tile);
    const y = game.y(tile);
    const xs = (x & 1) === 0 ? [x] : [x - 1, x + 1];
    const ys = (y & 1) === 0 ? [y] : [y - 1, y + 1];
    const links: { node: number; tiles: TileRef[] }[] = [];
    for (const lx of xs) {
      for (const ly of ys) {
        if (!game.isValidCoord(lx, ly)) continue;
        const tiles: TileRef[] = [];
        if (lx !== x) tiles.push(game.ref(lx, y));
        if (ly !== y) tiles.push(game.ref(lx, ly));
        const passable = tiles.every(
          (t) => game.isLand(t) && this.landCost(t) !== BLOCKED,
        );
        if (!passable) continue;
        links.push({ node: (ly >> 1) * this.cols + (lx >> 1), tiles });
      }
    }
    return links;
  }

  /** Appends the tiles of the lattice edge from `a` to `b`, after `a`. */
  private appendEdge(tiles: TileRef[], a: number, b: number): void {
    const ax = (a % this.cols) * 2;
    const ay = Math.floor(a / this.cols) * 2;
    const bx = (b % this.cols) * 2;
    const by = Math.floor(b / this.cols) * 2;
    const dx = Math.sign(bx - ax);
    const dy = Math.sign(by - ay);
    const steps = Math.abs(bx - ax) + Math.abs(by - ay);
    for (let j = 1; j <= steps; j++) {
      tiles.push(this.game.ref(ax + dx * j, ay + dy * j));
    }
  }
}

// One search per game: its scratch is sized to the map's lattice. Searches
// run one at a time in the single-threaded worker, and nothing carries over
// from one to the next, so sharing it changes no result.
const _landSearches = new WeakMap<Game, ConvoyLandSearch>();

function convoyLandSearch(game: Game): ConvoyLandSearch {
  let search = _landSearches.get(game);
  if (search === undefined) {
    search = new ConvoyLandSearch(game);
    _landSearches.set(game, search);
  }
  return search;
}
