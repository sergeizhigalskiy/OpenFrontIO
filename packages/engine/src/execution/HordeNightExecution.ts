import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import { euclDistFN } from "@openfront/engine-lib/game/GameMapImpl";
import {
  HORDE_BAND_LANDING_RADIUS,
  HORDE_BAND_MIN_SPACING,
  HORDE_BAND_PLACEMENT_TRIES,
  HORDE_BAND_TARGET_SAMPLES,
  HORDE_HUMAN_WAVE_PERCENT,
  HORDE_LANDING_RANGE,
  HORDE_NATION_WAVE_PERCENT,
  HORDE_START_LAND_TICKS,
  HORDE_TEAM,
  hordeBandCount,
  HordeNightOutcome,
  hordeWavePool,
  hordeWavesLanded,
  isHordeDefender,
} from "@openfront/engine-lib/game/HordeNight";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zNum,
  zPlayerRef,
  zRandom,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { HordeBandExecution } from "./HordeBandExecution";
import { PlayerExecution } from "./PlayerExecution";
import { TransportShipExecution } from "./TransportShipExecution";

// Distinct from the seeds of createGameRunner (+0), the Executor (+1),
// TribeSpawner (+2), CityStateSpawner (+3) and RuinsExecution (+4), so band
// ids don't follow theirs.
const HORDE_SEED_OFFSET = 5;

// Scratch for reachableShore: a flag per tile, all clear between searches.
let SEEN = new Uint8Array(0);

// Each game's Horde Night, so the win check can read the recorded land.
const hordes = new WeakMap<Game, HordeNightExecution>();

/** The game's Horde Night clock, while the mode is on. */
export function hordeNightOf(game: Game): HordeNightExecution | null {
  return hordes.get(game) ?? null;
}

/** Where a band comes ashore: a patch of free land, or a boat from the sea. */
type Landing =
  | { kind: "land"; site: TileRef }
  | { kind: "boat"; from: TileRef; to: TileRef };

/** A band sailing in, given its executions once its boat lands. */
interface InboundBand {
  band: Player;
  defender: Player;
  troops: number;
}

/**
 * Horde Night's wave clock (see engine-lib/game/HordeNight.ts). When the
 * first wave lands it records each defending human's land. On schedule it
 * lands each wave: for every living defender, 2 + wave / 2 bands sharing that
 * defender's pool, on free coast or map edge within HORDE_LANDING_RANGE of
 * it; with none there, by boat from the map edge to its coast. Each band is a
 * bot on HORDE_TEAM with a PlayerExecution (so pocket annexation and death
 * work as for anyone) and a HordeBandExecution aimed at that defender.
 */
export class HordeNightExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private wavesLanded = 0;
  // Each defending human's tiles when the first wave landed; null before.
  private startLand: Map<number, number> | null = null;
  private outcome: HordeNightOutcome = null;
  private inbound: InboundBand[] = [];

  /** `seed` is the game id. */
  constructor(seed: string) {
    this.random = new PseudoRandom(simpleHash(seed) + HORDE_SEED_OFFSET);
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
    hordes.set(mg, this);
  }

  tick(): void {
    if (this.mg.getWinner() !== null) {
      this.active = false;
      return;
    }
    // Before this tick's landings: a boat launched now is only built when
    // the executions added this tick start, at the end of it.
    this.welcomeInbound();
    const ticksSinceStart = Math.round(this.mg.elapsedGameSeconds() * 10);
    if (this.startLand === null && ticksSinceStart >= HORDE_START_LAND_TICKS) {
      this.recordStartLand();
    }
    while (this.wavesLanded < hordeWavesLanded(ticksSinceStart)) {
      this.wavesLanded++;
      this.landWave(this.wavesLanded);
    }
  }

  /** Waves landed so far. */
  waves(): number {
    return this.wavesLanded;
  }

  /** A defending human's tiles when the first wave landed, or null. */
  startTiles(player: Player): number | null {
    return this.startLand?.get(player.smallID()) ?? null;
  }

  /** Records how the night ended, for the view's end screen. */
  setOutcome(outcome: HordeNightOutcome): void {
    this.outcome = outcome;
    this.emit();
  }

  private recordStartLand(): void {
    const land = new Map<number, number>();
    for (const p of this.mg.allPlayers()) {
      if (p.type() !== PlayerType.Human || !isHordeDefender(p)) continue;
      if (!p.hasSpawned()) continue;
      land.set(p.smallID(), p.numTilesOwned());
    }
    this.startLand = land;
    this.emit();
  }

  private landWave(wave: number): void {
    const free = this.freeShore();
    const edgeWater = this.edgeOcean();
    let bands = 0;
    let troops = 0;
    for (const defender of this.mg.players()) {
      if (!isHordeDefender(defender)) continue;
      const type = defender.type();
      if (type !== PlayerType.Human && type !== PlayerType.Nation) continue;
      const pool = hordeWavePool(
        this.mg.config().maxTroops(defender),
        wave,
        type === PlayerType.Human
          ? HORDE_HUMAN_WAVE_PERCENT
          : HORDE_NATION_WAVE_PERCENT,
      );
      const landings = this.landingsFor(
        defender,
        hordeBandCount(wave),
        free,
        edgeWater,
      );
      if (pool < landings.length || landings.length === 0) continue;
      const each = Math.floor(pool / landings.length);
      let sent = 0;
      landings.forEach((landing, i) => {
        const name = `Horde ${wave}-${defender.smallID()}-${i + 1}`;
        if (this.landBand(landing, defender, each, name)) sent++;
      });
      bands += sent;
      troops += sent * each;
      if (type === PlayerType.Human && sent > 0) {
        this.mg.displayMessage(
          "events_display.horde_wave_incoming",
          MessageType.NAVAL_INVASION_INBOUND,
          defender.id(),
          undefined,
          { wave, bands: sent, troops: renderTroops(sent * each) },
        );
      }
    }
    this.mg.displayMessage(
      "events_display.horde_wave_landed",
      MessageType.NAVAL_INVASION_INBOUND,
      null,
      undefined,
      { wave, bands, troops: renderTroops(troops) },
    );
  }

  /** Passable free land on the map edge or a coast, in tile order. */
  private freeShore(): TileRef[] {
    const map = this.mg.map();
    const free: TileRef[] = [];
    map.forEachTile((tile) => {
      if (!map.isLand(tile) || map.isImpassable(tile)) return;
      if (!map.isShore(tile) && !map.isOnEdgeOfMap(tile)) return;
      if (map.ownerID(tile) !== 0 || map.hasFallout(tile)) return;
      free.push(tile);
    });
    return free;
  }

  /** Ocean tiles on the map edge, where boats come in from. */
  private edgeOcean(): TileRef[] {
    const map = this.mg.map();
    const w = map.width();
    const h = map.height();
    const tiles: TileRef[] = [];
    const add = (x: number, y: number) => {
      const t = map.ref(x, y);
      if (map.isOcean(t)) tiles.push(t);
    };
    for (let x = 0; x < w; x++) {
      add(x, 0);
      if (h > 1) add(x, h - 1);
    }
    for (let y = 1; y < h - 1; y++) {
      add(0, y);
      if (w > 1) add(w - 1, y);
    }
    return tiles;
  }

  /**
   * Up to `count` landings for `defender`'s bands: the free coast or map
   * edge nearest to it that a band can walk to it from over free land,
   * within HORDE_LANDING_RANGE, spread out; else boats from the map edge to
   * its ocean coast; else free coast within HORDE_LANDING_RANGE (the bands
   * fight their way through); else the free coast nearest to it.
   */
  landingsFor(
    defender: Player,
    count: number,
    free: readonly TileRef[],
    edgeWater: readonly TileRef[],
  ): Landing[] {
    const reachable = this.reachableShore(defender, count);
    if (reachable.length > 0) {
      return reachable.map((site) => ({ kind: "land", site }));
    }
    const coast = this.coastNearestEdge(defender);
    if (coast.length > 0 && edgeWater.length > 0) {
      // The shortest crossings first: the coast nearest the map edge.
      const spacing2 = HORDE_BAND_MIN_SPACING * HORDE_BAND_MIN_SPACING;
      const sites: TileRef[] = [];
      for (const spacing of [spacing2, 0]) {
        for (const t of coast) {
          if (sites.length >= count) break;
          if (
            sites.every(
              (s) => s !== t && this.mg.euclideanDistSquared(s, t) >= spacing,
            )
          ) {
            sites.push(t);
          }
        }
      }
      return sites.map((to) => ({
        kind: "boat",
        from: this.nearest(edgeWater, to),
        to,
      }));
    }
    const samples = this.borderSample(defender);
    if (samples.length === 0) return [];
    const near = this.within(free, samples, HORDE_LANDING_RANGE);
    if (near.length > 0) {
      return this.spread(near, count).map((site) => ({ kind: "land", site }));
    }
    // Nowhere near and no coast to sail to: the free coast nearest to it.
    let best = Number.MAX_SAFE_INTEGER;
    for (const t of free) best = Math.min(best, this.dist2(t, samples));
    if (best === Number.MAX_SAFE_INTEGER) return [];
    const nearest = this.within(
      free,
      samples,
      Math.floor(Math.sqrt(best)) + HORDE_LANDING_RANGE,
    );
    return this.spread(nearest, count).map((site) => ({ kind: "land", site }));
  }

  /**
   * Up to `count` free coast or map edge tiles a band can walk to
   * `defender` from over free land, nearest first (a breadth-first search
   * from its border out to HORDE_LANDING_RANGE), HORDE_BAND_MIN_SPACING
   * apart while there are enough, then closer.
   */
  private reachableShore(defender: Player, count: number): TileRef[] {
    const map = this.mg.map();
    const isFree = (t: TileRef) =>
      map.isLand(t) &&
      !map.isImpassable(t) &&
      map.ownerID(t) === 0 &&
      !map.hasFallout(t);
    const seen = this.scratch();
    const touched: TileRef[] = [];
    const mark = (t: TileRef) => {
      seen[t] = 1;
      touched.push(t);
    };
    let frontier: TileRef[] = [];
    const nbuf: TileRef[] = [0, 0, 0, 0];
    defender.borderTiles().forEach((b) => {
      const n = map.neighbors4(b, nbuf);
      for (let i = 0; i < n; i++) {
        const t = nbuf[i];
        if (seen[t] === 0 && isFree(t)) {
          mark(t);
          frontier.push(t);
        }
      }
    });
    const spacing2 = HORDE_BAND_MIN_SPACING * HORDE_BAND_MIN_SPACING;
    const candidates: TileRef[] = [];
    const sites: TileRef[] = [];
    for (
      let depth = 0;
      depth < HORDE_LANDING_RANGE &&
      frontier.length > 0 &&
      sites.length < count;
      depth++
    ) {
      const next: TileRef[] = [];
      for (const t of frontier) {
        if (map.isShore(t) || map.isOnEdgeOfMap(t)) {
          candidates.push(t);
          if (
            sites.length < count &&
            sites.every((s) => map.euclideanDistSquared(s, t) >= spacing2)
          ) {
            sites.push(t);
          }
        }
        const n = map.neighbors4(t, nbuf);
        for (let i = 0; i < n; i++) {
          const u = nbuf[i];
          if (seen[u] === 0 && isFree(u)) {
            mark(u);
            next.push(u);
          }
        }
      }
      frontier = next;
    }
    for (const t of touched) seen[t] = 0;
    // Too little coast for the spacing: fill in with the nearest left.
    for (const t of candidates) {
      if (sites.length >= count) break;
      if (!sites.includes(t)) sites.push(t);
    }
    return sites;
  }

  // A flag per tile for the searches, cleared after each. Module scratch,
  // not game state (the simulation is single-threaded).
  private scratch(): Uint8Array {
    const size = this.mg.width() * this.mg.height();
    if (SEEN.length !== size) SEEN = new Uint8Array(size);
    return SEEN;
  }

  // `player`'s ocean coast, nearest the map edge first (ties by tile).
  private coastNearestEdge(player: Player): TileRef[] {
    const map = this.mg.map();
    const w = map.width();
    const h = map.height();
    const edgeDist = (t: TileRef) => {
      const x = map.x(t);
      const y = map.y(t);
      return Math.min(x, y, w - 1 - x, h - 1 - y);
    };
    const coast: TileRef[] = [];
    player.borderTiles().forEach((t) => {
      if (map.isOceanShore(t)) coast.push(t);
    });
    return coast.sort((a, b) => edgeDist(a) - edgeDist(b) || a - b);
  }

  // Up to HORDE_BAND_TARGET_SAMPLES of `player`'s border tiles, evenly picked.
  private borderSample(player: Player): TileRef[] {
    const border = player.borderTiles();
    const step = Math.max(
      1,
      Math.ceil(border.size / HORDE_BAND_TARGET_SAMPLES),
    );
    const samples: TileRef[] = [];
    let i = 0;
    border.forEach((t) => {
      if (i++ % step === 0) samples.push(t);
    });
    return samples;
  }

  // The tiles of `pool` within `range` of any of `samples`.
  private within(
    pool: readonly TileRef[],
    samples: readonly TileRef[],
    range: number,
  ): TileRef[] {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of samples) {
      const x = this.mg.x(s);
      const y = this.mg.y(s);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const range2 = range * range;
    return pool.filter((t) => {
      const x = this.mg.x(t);
      const y = this.mg.y(t);
      if (x < minX - range || x > maxX + range) return false;
      if (y < minY - range || y > maxY + range) return false;
      return this.dist2(t, samples) <= range2;
    });
  }

  private dist2(tile: TileRef, samples: readonly TileRef[]): number {
    let best = Number.MAX_SAFE_INTEGER;
    for (const s of samples) {
      const d = this.mg.euclideanDistSquared(tile, s);
      if (d < best) best = d;
    }
    return best;
  }

  private nearest(pool: readonly TileRef[], to: TileRef): TileRef {
    let best = pool[0];
    let bestD = Number.MAX_SAFE_INTEGER;
    for (const t of pool) {
      const d = this.mg.euclideanDistSquared(t, to);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  // Up to `count` distinct tiles of `pool`, HORDE_BAND_MIN_SPACING apart
  // while the pool allows, then closer.
  private spread(pool: readonly TileRef[], count: number): TileRef[] {
    const sites: TileRef[] = [];
    for (const spacing of [HORDE_BAND_MIN_SPACING, 0]) {
      const spacing2 = spacing * spacing;
      for (
        let tries = 0;
        sites.length < count &&
        sites.length < pool.length &&
        tries < HORDE_BAND_PLACEMENT_TRIES * count;
        tries++
      ) {
        const tile = pool[this.random.nextInt(0, pool.length)];
        if (
          sites.every(
            (s) =>
              s !== tile && this.mg.euclideanDistSquared(s, tile) >= spacing2,
          )
        ) {
          sites.push(tile);
        }
      }
    }
    return sites;
  }

  private newBand(name: string): Player {
    let id = this.random.nextID();
    while (this.mg.hasPlayer(id)) id = this.random.nextID();
    return this.mg.addPlayer(
      new PlayerInfo(name, PlayerType.Bot, null, id),
      HORDE_TEAM,
    );
  }

  // Lands one band: on the free land around its site, or in a boat that sets
  // out from the map edge.
  private landBand(
    landing: Landing,
    defender: Player,
    troops: number,
    name: string,
  ): boolean {
    if (landing.kind === "boat") {
      const band = this.newBand(name);
      band.setTroops(troops);
      band.setSpawnTile(landing.to);
      this.mg.addExecution(
        TransportShipExecution.fromSea(band, landing.from, landing.to, troops),
      );
      this.inbound.push({ band, defender, troops });
      return true;
    }
    const map = this.mg.map();
    const site = landing.site;
    const tiles: TileRef[] = [];
    this.mg
      .bfs(site, euclDistFN(site, HORDE_BAND_LANDING_RADIUS, true))
      .forEach((tile) => {
        if (!map.isLand(tile) || map.isImpassable(tile)) return;
        // Never on held land: only free tiles.
        if (map.ownerID(tile) !== 0 || map.hasFallout(tile)) return;
        tiles.push(tile);
      });
    if (tiles.length === 0) return false;

    const band = this.newBand(name);
    for (const tile of tiles) band.conquer(tile);
    band.setSpawnTile(tiles.includes(site) ? site : tiles[0]);
    band.setTroops(troops);
    this.mg.addExecution(
      new PlayerExecution(band),
      new HordeBandExecution(band, defender, troops),
    );
    return true;
  }

  // Bands whose boat has come ashore start fighting; ones whose boat was
  // lost are dropped.
  private welcomeInbound(): void {
    if (this.inbound.length === 0) return;
    const still: InboundBand[] = [];
    for (const b of this.inbound) {
      if (b.band.isAlive()) {
        this.mg.addExecution(
          new PlayerExecution(b.band),
          new HordeBandExecution(b.band, b.defender, b.troops),
        );
      } else if (b.band.units().length > 0) {
        still.push(b);
      } else {
        b.band.removeTroops(b.band.troops());
      }
    }
    this.inbound = still;
  }

  private emit(): void {
    const startLand: number[] = [];
    for (const [id, tiles] of this.startLand ?? []) startLand.push(id, tiles);
    this.mg.addUpdate({
      type: GameUpdateType.Cataclysm,
      kind: "horde",
      startLand,
      outcome: this.outcome,
    });
  }

  viewResync(): void {
    if (this.mg !== undefined) this.emit();
  }

  isActive(): boolean {
    return this.active;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return HordeNightExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      random: w.random(this.random),
      wavesLanded: this.wavesLanded,
      startLand:
        this.startLand === null
          ? null
          : Array.from(this.startLand, ([id, tiles]) => [id, tiles]),
      outcome: this.outcome,
      inbound: this.inbound.map((b) => ({
        band: w.player(b.band),
        defender: w.player(b.defender),
        troops: b.troops,
      })),
    });
  }

  restoreSnapshot(s: HordeNightState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) {
      this.mg = r.game;
      hordes.set(r.game, this);
    }
    this.random = r.random(s.random);
    this.wavesLanded = s.wavesLanded;
    this.startLand =
      s.startLand === null
        ? null
        : new Map(s.startLand.map(([id, tiles]) => [id, tiles]));
    this.outcome = s.outcome;
    this.inbound = s.inbound.map((b) => ({
      band: r.player(b.band),
      defender: r.player(b.defender),
      troops: b.troops,
    }));
  }
}

const HordeNightStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom(),
  wavesLanded: zInt(),
  // [smallID, tiles] per defending human, in the order recorded.
  startLand: z.array(z.tuple([zInt(), zInt()])).nullable(),
  outcome: z.enum(["defenders", "narrow", "horde"]).nullable(),
  inbound: z.array(
    z.object({
      band: zPlayerRef(),
      defender: zPlayerRef(),
      troops: zNum(),
    }),
  ),
});
type HordeNightState = z.infer<typeof HordeNightStateSchema>;

export const HordeNightExecutionSnapshot = execSnapshotType({
  name: "HordeNight",
  version: 2,
  schema: HordeNightStateSchema,
  // v2: per-defender waves, the land recorded at the first wave and bands
  // sailing in. An older game has no recorded land, so nobody is overrun.
  migrations: {
    1: (d) => ({
      ...(d as Record<string, unknown>),
      startLand: null,
      outcome: null,
      inbound: [],
    }),
  },
  cls: () => HordeNightExecution,
});
