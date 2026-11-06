import { GameMap, TileRef } from "@openfront/engine-api/game/GameMap";
import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  HORDE_BOAT_EXPOSED_TILE_COST,
  HORDE_BOAT_REPLAN_TICKS,
  hordeBoatShellLoss,
  isHordeBand,
  mayShootHordeBoat,
} from "@openfront/engine-lib/game/HordeNight";
import {
  zInt,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { z } from "zod";
import { Game, Player, Unit } from "../game/Game";
import { WaterPathFinder } from "../pathfinding/PathFinder";
import { PathFinderBuilder } from "../pathfinding/PathFinderBuilder";
import { MiniMapTransformer } from "../pathfinding/transformers/MiniMapTransformer";
import { ShoreCoercingTransformer } from "../pathfinding/transformers/ShoreCoercingTransformer";
import { PathFinder, PathResult, PathStatus } from "../pathfinding/types";

/**
 * Horde boats (engine-lib/game/HordeNight.ts): the transport ships of horde
 * bands. A boat records the player it sails at as its targetPlayer, so
 * warships can tell whose it is to shoot (mayShootHordeBoat); a shell kills
 * a tenth of its troops instead of sinking it; and it routes around the
 * warships that may shoot it, a water tile they cover costing
 * HORDE_BOAT_EXPOSED_TILE_COST plain ones, planning again every
 * HORDE_BOAT_REPLAN_TICKS while it sails.
 */

/** A horde band's transport ship. */
export function isHordeBoat(unit: Unit): boolean {
  return unit.type() === UnitType.TransportShip && isHordeBand(unit.owner());
}

/** The player a horde boat sails at, or null. */
export function hordeBoatAimedAt(boat: Unit): Player | null {
  const target = boat.targetPlayer();
  return target !== undefined && target.isPlayer() ? target : null;
}

/** Whether a warship of `shooter` may fire at the horde boat `boat`. */
export function mayShootAtHordeBoat(shooter: Player, boat: Unit): boolean {
  return mayShootHordeBoat(shooter, hordeBoatAimedAt(boat));
}

/** A shell hits a horde boat: a tenth of its troops die; with none left it sinks. */
export function shellHordeBoat(boat: Unit, attacker: Player): void {
  if (!boat.isActive()) return;
  boat.setTroops(boat.troops() - hordeBoatShellLoss(boat.troops()));
  if (boat.troops() <= 0) boat.delete(true, attacker);
}

/**
 * The tiles of the warships that may shoot a horde boat sailing at
 * `aimedAt`, in unit order: the threats its route avoids.
 */
export function hordeBoatThreats(
  game: Game,
  aimedAt: Player | null,
): TileRef[] {
  if (aimedAt === null) return [];
  const tiles: TileRef[] = [];
  for (const ship of game.units(UnitType.Warship)) {
    if (!ship.isActive()) continue;
    if (!mayShootHordeBoat(ship.owner(), aimedAt)) continue;
    tiles.push(ship.tile());
  }
  return tiles;
}

/** The warships' reach, from the game's config. */
function threatRange(game: Game): number {
  return game.config().warshipTargettingRange();
}

/** How many tiles of `path` lie within a threat's reach. */
export function hordeRouteExposure(
  game: Game,
  path: ArrayLike<TileRef>,
  threats: readonly TileRef[],
): number {
  if (threats.length === 0) return 0;
  const range2 = threatRange(game) ** 2;
  let exposed = 0;
  for (let i = 0; i < path.length; i++) {
    const t = path[i];
    if (!game.isWater(t)) continue;
    for (const w of threats) {
      if (game.euclideanDistSquared(t, w) <= range2) {
        exposed++;
        break;
      }
    }
  }
  return exposed;
}

/** A route's cost for a horde boat: a plain tile 1, an exposed one 8. */
export function hordeRouteCost(
  game: Game,
  path: ArrayLike<TileRef>,
  threats: readonly TileRef[],
): number {
  return (
    path.length +
    (HORDE_BOAT_EXPOSED_TILE_COST - 1) * hordeRouteExposure(game, path, threats)
  );
}

const LAND_MASK = 1 << 7;

/** Binary min-heap with float64 priorities (exact for our integer keys). */
class Heap {
  private nodes = new Int32Array(1024);
  private keys = new Float64Array(1024);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(node: number, key: number): void {
    if (this.size === this.nodes.length) {
      const nodes = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      nodes.set(this.nodes);
      keys.set(this.keys);
      this.nodes = nodes;
      this.keys = keys;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.nodes[i] = this.nodes[parent];
      this.keys[i] = this.keys[parent];
      i = parent;
    }
    this.nodes[i] = node;
    this.keys[i] = key;
  }

  pop(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes[--this.size];
    const lastKey = this.keys[this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= this.size) break;
      const r = l + 1;
      const c = r < this.size && this.keys[r] < this.keys[l] ? r : l;
      if (this.keys[c] >= lastKey) break;
      this.nodes[i] = this.nodes[c];
      this.keys[i] = this.keys[c];
      i = c;
    }
    this.nodes[i] = lastNode;
    this.keys[i] = lastKey;
    return top;
  }
}

/**
 * A* over the half-resolution minimap's water in which a cell within a
 * threat's reach costs HORDE_BOAT_EXPOSED_TILE_COST and any other water cell
 * 1: the cheapest route, which goes around the threats where open water
 * allows and through the least of them where it doesn't. Set `threats`
 * (minimap cells and their reach) before each search.
 */
class ThreatWaterAStar implements PathFinder<number> {
  threats: { x: number; y: number }[] = [];
  reach2 = 0;
  private stamp = 0;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private readonly g: Uint32Array;
  private readonly cameFrom: Int32Array;
  private readonly heap = new Heap();
  private readonly terrain: Uint8Array;
  private readonly width: number;
  private readonly height: number;

  constructor(map: GameMap) {
    this.terrain = (map as unknown as { terrain: Uint8Array }).terrain;
    this.width = map.width();
    this.height = map.height();
    const n = this.width * this.height;
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.g = new Uint32Array(n);
    this.cameFrom = new Int32Array(n);
  }

  private cost(node: number): number {
    const x = node % this.width;
    const y = (node / this.width) | 0;
    for (const t of this.threats) {
      const dx = x - t.x;
      const dy = y - t.y;
      if (dx * dx + dy * dy <= this.reach2) return HORDE_BOAT_EXPOSED_TILE_COST;
    }
    return 1;
  }

  findPath(start: number | number[], goal: number): number[] | null {
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const { width, height, terrain, seen, closed, g, cameFrom, heap } = this;
    const gx = goal % width;
    const gy = (goal / width) | 0;
    // Ties go to the cell nearer the goal; keys stay exact integers.
    const key = (f: number, h: number) => f * 8192 + h;
    heap.clear();
    for (const s of Array.isArray(start) ? start : [start]) {
      seen[s] = stamp;
      g[s] = 0;
      cameFrom[s] = -1;
      const h = Math.abs((s % width) - gx) + Math.abs(((s / width) | 0) - gy);
      heap.push(s, key(h, h));
    }
    let budget = width * height * 2;
    const nbr = [0, 0, 0, 0];
    while (heap.size > 0) {
      if (--budget <= 0) return null;
      const cur = heap.pop();
      if (closed[cur] === stamp) continue;
      closed[cur] = stamp;
      if (cur === goal) return this.build(goal);
      const cx = cur % width;
      const cy = (cur / width) | 0;
      let n = 0;
      if (cy > 0) nbr[n++] = cur - width;
      if (cy < height - 1) nbr[n++] = cur + width;
      if (cx > 0) nbr[n++] = cur - 1;
      if (cx < width - 1) nbr[n++] = cur + 1;
      for (let i = 0; i < n; i++) {
        const nb = nbr[i];
        if (closed[nb] === stamp) continue;
        if (nb !== goal && (terrain[nb] & LAND_MASK) !== 0) continue;
        const tg = g[cur] + this.cost(nb);
        if (seen[nb] === stamp && tg >= g[nb]) continue;
        seen[nb] = stamp;
        g[nb] = tg;
        cameFrom[nb] = cur;
        const h =
          Math.abs((nb % width) - gx) + Math.abs(((nb / width) | 0) - gy);
        heap.push(nb, key(tg + h, h));
      }
    }
    return null;
  }

  private build(goal: number): number[] {
    const path: number[] = [];
    for (let c = goal; c !== -1; c = this.cameFrom[c]) path.push(c);
    return path.reverse();
  }
}

// The usual water route finder, one per game: one-shot queries only.
const plainFinders = new WeakMap<Game, WaterPathFinder>();
function plainWater(game: Game): WaterPathFinder {
  let pf = plainFinders.get(game);
  if (pf === undefined) {
    pf = new WaterPathFinder(game);
    plainFinders.set(game, pf);
  }
  return pf;
}

// One threat-aware router per game, rebuilt with the water graph.
const routers = new WeakMap<
  Game,
  { version: number; astar: ThreatWaterAStar; chain: PathFinder<number> }
>();

function router(game: Game) {
  const version = game.waterGraphVersion();
  let r = routers.get(game);
  if (r === undefined || r.version !== version) {
    const miniMap = game.miniMap();
    const astar = new ThreatWaterAStar(miniMap);
    const chain = PathFinderBuilder.create<number>(astar)
      .wrap((pf) => new ShoreCoercingTransformer(pf, miniMap))
      .wrap((pf) => new MiniMapTransformer(pf, game.map(), miniMap))
      .build();
    r = { version, astar, chain };
    routers.set(game, r);
  }
  return r;
}

/** The usual water route from `from` to `to`, as any other ship sails it. */
export function hordePlainRoute(
  game: Game,
  from: TileRef,
  to: TileRef,
): TileRef[] | null {
  return plainWater(game).findPath(from, to);
}

/**
 * The horde boat's route from `from` to `to` past `threats`: the usual water
 * route when no threat covers it (it is then as cheap as any), else the
 * cheapest route under the exposure cost. Null when there is no water route.
 */
export function hordeBoatRoute(
  game: Game,
  from: TileRef,
  to: TileRef,
  threats: readonly TileRef[],
): TileRef[] | null {
  return plannedRoute(game, from, to, threats)?.path ?? null;
}

// hordeBoatRoute, and whether it left the usual route to get round a threat.
function plannedRoute(
  game: Game,
  from: TileRef,
  to: TileRef,
  threats: readonly TileRef[],
): { path: TileRef[]; detoured: boolean } | null {
  const direct = plainWater(game).findPath(from, to);
  if (direct === null) return null;
  const plain = { path: direct, detoured: false };
  if (hordeRouteExposure(game, direct, threats) === 0) return plain;
  const r = router(game);
  r.astar.threats = threats.map((t) => ({
    x: Math.floor(game.x(t) / 2),
    y: Math.floor(game.y(t) / 2),
  }));
  r.astar.reach2 = Math.floor(threatRange(game) / 2) ** 2;
  const around = r.chain.findPath(from, to);
  if (around === null || around.length === 0) return plain;
  // The minimap rounds: keep whichever the full map prices lower.
  return hordeRouteCost(game, around, threats) <
    hordeRouteCost(game, direct, threats)
    ? { path: around, detoured: true }
    : plain;
}

const sameTiles = (a: readonly TileRef[], b: readonly TileRef[]) =>
  a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * A horde boat's stepping pathfinder, standing in for WaterPathFinder in
 * TransportShipExecution. It follows a hordeBoatRoute, and every
 * HORDE_BOAT_REPLAN_TICKS looks at the warships that may shoot it again and
 * plans from where it is. It skips the search when the answer can't have
 * changed: the same warships where they were (the rest of the route is
 * still the cheapest), or none in reach of the usual route it is on (no
 * route is cheaper than the usual one unexposed). A new plan sets
 * `rebuilt`, and the execution records a new motion plan for the view.
 */
export class HordeBoatPathFinder {
  private path: Uint32Array | null = null;
  private pathIndex = 0;
  private lastTo: TileRef | null = null;
  private nextPlanTick = 0;
  private planThreats: TileRef[] = [];
  // Whether the plan left the usual route to get round a threat.
  private detoured = false;
  private _rebuilt = false;

  constructor(
    private game: Game,
    private aimedAt: Player | null,
  ) {}

  get rebuilt(): boolean {
    return this.takeRebuilt();
  }

  /** The player the boat sails at. */
  aimedAtPlayer(): Player | null {
    return this.aimedAt;
  }

  takeRebuilt(): boolean {
    const v = this._rebuilt;
    this._rebuilt = false;
    return v;
  }

  private plan(from: TileRef, to: TileRef, threats: TileRef[]): void {
    const planned = plannedRoute(this.game, from, to, threats);
    const route = planned?.path ?? null;
    this.detoured = planned?.detoured ?? false;
    this.path = route === null ? null : Uint32Array.from(route);
    this.pathIndex = route !== null && route[0] === from ? 1 : 0;
    this.lastTo = to;
    this.planThreats = threats;
    this.nextPlanTick = this.game.ticks() + HORDE_BOAT_REPLAN_TICKS;
  }

  /** The route from `from` to `to`, adopted as the plan when there is none for `to`. */
  findPath(from: TileRef, to: TileRef): TileRef[] | null {
    if (this.path === null || this.lastTo !== to) {
      this.plan(from, to, hordeBoatThreats(this.game, this.aimedAt));
    }
    return this.path === null ? null : Array.from(this.path);
  }

  next(from: TileRef, to: TileRef): PathResult<TileRef> {
    if (from === to) return { status: PathStatus.COMPLETE, node: to };
    if (this.path === null || this.lastTo !== to) {
      this.plan(from, to, hordeBoatThreats(this.game, this.aimedAt));
      this._rebuilt = true;
    } else if (this.game.ticks() >= this.nextPlanTick) {
      const threats = hordeBoatThreats(this.game, this.aimedAt);
      if (
        sameTiles(threats, this.planThreats) ||
        (!this.detoured &&
          hordeRouteExposure(
            this.game,
            this.path.subarray(Math.max(0, this.pathIndex - 1)),
            threats,
          ) === 0)
      ) {
        this.nextPlanTick = this.game.ticks() + HORDE_BOAT_REPLAN_TICKS;
      } else {
        this.plan(from, to, threats);
        this._rebuilt = true;
      }
    }
    if (
      this.path !== null &&
      this.pathIndex > 0 &&
      this.path[this.pathIndex - 1] !== from
    ) {
      // Off its route (pushed by a storm hold, say): plan from here.
      this.plan(from, to, hordeBoatThreats(this.game, this.aimedAt));
      this._rebuilt = true;
    }
    if (this.path === null) return { status: PathStatus.NOT_FOUND };
    if (this.pathIndex >= this.path.length) {
      return { status: PathStatus.COMPLETE, node: to };
    }
    return { status: PathStatus.NEXT, node: this.path[this.pathIndex++] };
  }

  /** The route from the tile next() last stepped to, for the motion plan. */
  pathForTraversal(from: TileRef, to: TileRef): TileRef[] | Uint32Array {
    if (this.path === null || this.pathIndex === 0) {
      return this.findPath(from, to) ?? [from];
    }
    const rest = this.path.slice(this.pathIndex - 1);
    return rest[0] === from ? rest : [from, ...rest];
  }

  getState(): HordeRouteState {
    return {
      path: this.path === null ? null : this.path.slice(),
      pathIndex: this.pathIndex,
      lastTo: this.lastTo,
      nextPlanTick: this.nextPlanTick,
      planThreats: Uint32Array.from(this.planThreats),
      detoured: this.detoured,
      rebuilt: this._rebuilt,
    };
  }

  static fromState(
    game: Game,
    aimedAt: Player | null,
    s: HordeRouteState,
  ): HordeBoatPathFinder {
    const pf = new HordeBoatPathFinder(game, aimedAt);
    pf.path = s.path === null ? null : Uint32Array.from(s.path);
    pf.pathIndex = s.pathIndex;
    pf.lastTo = s.lastTo;
    pf.nextPlanTick = s.nextPlanTick;
    pf.planThreats = Array.from(s.planThreats);
    pf.detoured = s.detoured;
    pf._rebuilt = s.rebuilt;
    return pf;
  }
}

export const HordeRouteSchema = z.object({
  path: zTiles().nullable(),
  pathIndex: zInt(),
  lastTo: zTile().nullable(),
  nextPlanTick: zInt(),
  planThreats: zTiles(),
  detoured: z.boolean(),
  rebuilt: z.boolean(),
});
export type HordeRouteState = z.infer<typeof HordeRouteSchema>;
