import { TileRef } from "@openfront/engine-api/game/GameMap";
import { MessageType, Structures } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  selectVolcanoSites,
  tilesInRadius,
  troopsLostWithLand,
  VOLCANO_ERUPTION_RADIUS,
  VOLCANO_FALLOUT_TICKS,
  VOLCANO_FIRST_RUMBLE_TICKS,
  VOLCANO_MAX_INTERVAL_TICKS,
  VOLCANO_MIN_INTERVAL_TICKS,
  VOLCANO_WARNING_RADIUS,
  VOLCANO_WARNING_TICKS,
  VolcanoSitePosition,
} from "@openfront/engine-lib/game/Volcanoes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  zInt,
  zRandom,
  zTile,
  zTiles,
} from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import { cityStateZones, overlapsZone } from "../game/StartPlacements";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";

// Each game's volcano execution, so nations can see the warning ring.
const volcanoes = new WeakMap<Game, VolcanoExecution>();

/** True while a site rumbles and `tile` is inside its warning ring. */
/** The game's volcano sites; empty without volcanoes or before tick 0. */
export function volcanoSitesOf(game: Game): readonly TileRef[] {
  return volcanoes.get(game)?.siteTiles() ?? [];
}

export function inVolcanoWarning(game: Game, tile: TileRef): boolean {
  return volcanoes.get(game)?.inWarningRing(tile) ?? false;
}

/**
 * Volcanoes (lobby modifier; numbers in engine-lib/game/Volcanoes.ts).
 *
 * The sites are picked once, when the execution starts at tick 0, so every
 * view can show them from the spawn phase on. After the spawn phase plus
 * VOLCANO_FIRST_RUMBLE_TICKS, and then every 8 to 12 minutes (seeded), one
 * site starts rumbling: a warning ring goes up for VOLCANO_WARNING_TICKS and
 * every player with land inside it gets a message. Then it erupts. Inside
 * VOLCANO_ERUPTION_RADIUS every tile loses its owner, every structure is
 * destroyed, and fallout covers the land for VOLCANO_FALLOUT_TICKS. Each
 * player hit loses their troops per tile times the tiles they lost. No one
 * is credited: it is environmental, like a structure lost to its own nuke.
 *
 * Deterministic: the PRNG is seeded from the game id and stored in snapshots.
 */
export class VolcanoExecution implements Execution {
  private active = true;
  private mg: Game | null = null;
  private random: PseudoRandom;
  private sites: TileRef[] = [];
  /** Tick the next site starts rumbling; null until the spawn phase ends. */
  private nextRumbleTick: number | null = null;
  private rumblingSite: TileRef | null = null;
  /** Tick the rumbling site erupts; 0 while none rumbles. */
  private eruptionTick = 0;
  /** Fallout each eruption left, oldest first, cleared at `until`. */
  private fallout: { until: number; tiles: TileRef[] }[] = [];

  /**
   * @param manualSites The map's hand-placed `volcanoes` (info.json), used
   *   instead of auto-placement when present.
   */
  constructor(
    gameID: GameID,
    private manualSites: readonly VolcanoSitePosition[] | null = null,
  ) {
    this.random = new PseudoRandom(simpleHash(`${gameID}:volcanoes`));
  }

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    // City-states came first: no warning ring reaches one (StartPlacements).
    const cityStates = cityStateZones(mg);
    this.sites = selectVolcanoSites(mg.map(), this.manualSites, (tile) =>
      overlapsZone(mg, cityStates, tile, VOLCANO_WARNING_RADIUS),
    );
    volcanoes.set(mg, this);
    this.emit(null);
  }

  tick(ticks: number): void {
    const mg = this.mg;
    if (mg === null) throw new Error("Not initialized");
    if (mg.inSpawnPhase()) return;
    this.nextRumbleTick ??=
      ticks -
      Math.round(mg.elapsedGameSeconds() * 10) +
      VOLCANO_FIRST_RUMBLE_TICKS;
    this.clearFallout(mg, ticks);
    if (this.rumblingSite !== null) {
      if (ticks >= this.eruptionTick) this.erupt(mg, this.rumblingSite, ticks);
      return;
    }
    if (ticks >= this.nextRumbleTick && this.sites.length > 0) {
      this.rumble(mg, ticks);
    }
  }

  siteTiles(): readonly TileRef[] {
    return this.sites;
  }

  inWarningRing(tile: TileRef): boolean {
    if (this.mg === null || this.rumblingSite === null) return false;
    return (
      this.mg.euclideanDistSquared(tile, this.rumblingSite) <=
      VOLCANO_WARNING_RADIUS * VOLCANO_WARNING_RADIUS
    );
  }

  private rumble(mg: Game, ticks: number): void {
    const site = this.sites[this.random.nextInt(0, this.sites.length)];
    this.rumblingSite = site;
    this.eruptionTick = ticks + VOLCANO_WARNING_TICKS;
    this.nextRumbleTick =
      ticks +
      this.random.nextInt(
        VOLCANO_MIN_INTERVAL_TICKS,
        VOLCANO_MAX_INTERVAL_TICKS + 1,
      );
    // Everyone with land inside the ring, in the order the scan meets them.
    const warned = new Set<Player>();
    for (const tile of tilesInRadius(mg.map(), site, VOLCANO_WARNING_RADIUS)) {
      const owner = mg.owner(tile);
      if (owner.isPlayer()) warned.add(owner);
    }
    for (const player of warned) {
      mg.displayMessage(
        "events_display.volcano_rumbling",
        MessageType.NUKE_INBOUND,
        player.id(),
        undefined,
        { seconds: VOLCANO_WARNING_TICKS / 10 },
      );
    }
    this.emit(null);
  }

  private erupt(mg: Game, site: TileRef, ticks: number): void {
    const tilesBefore = new Map<Player, number>();
    const tilesLost = new Map<Player, number>();
    const fallout: TileRef[] = [];
    for (const tile of tilesInRadius(mg.map(), site, VOLCANO_ERUPTION_RADIUS)) {
      if (!mg.isLand(tile) || mg.isImpassable(tile)) continue;
      const owner = mg.owner(tile);
      if (owner.isPlayer()) {
        if (!tilesBefore.has(owner)) {
          tilesBefore.set(owner, owner.numTilesOwned());
        }
        owner.relinquish(tile);
        tilesLost.set(owner, (tilesLost.get(owner) ?? 0) + 1);
      }
      // Must run after relinquish: setFallout throws on owned tiles.
      if (!mg.hasFallout(tile)) {
        mg.setFallout(tile, true);
        fallout.push(tile);
      }
      mg.queueNukeImpact(tile);
    }
    for (const { unit } of mg.nearbyUnits(
      site,
      VOLCANO_ERUPTION_RADIUS,
      Structures.types,
      undefined,
      true,
    )) {
      if (unit.isActive()) unit.delete(true);
    }
    for (const [player, lost] of tilesLost) {
      player.removeTroops(
        troopsLostWithLand(player.troops(), tilesBefore.get(player)!, lost),
      );
      mg.displayMessage(
        "events_display.volcano_erupted",
        MessageType.NUKE_DETONATED,
        player.id(),
        undefined,
        { tiles: lost },
      );
    }
    if (fallout.length > 0) {
      this.fallout.push({
        until: ticks + VOLCANO_FALLOUT_TICKS,
        tiles: fallout,
      });
    }
    this.rumblingSite = null;
    this.eruptionTick = 0;
    this.emit(site);
  }

  /** Lifts the fallout eruptions left once it has lasted its time. */
  private clearFallout(mg: Game, ticks: number): void {
    while (this.fallout.length > 0 && this.fallout[0].until <= ticks) {
      for (const tile of this.fallout.shift()!.tiles) {
        // Land retaken since is already clean, and a flooded tile is water.
        if (mg.isLand(tile) && !mg.hasOwner(tile) && mg.hasFallout(tile)) {
          mg.setFallout(tile, false);
        }
      }
    }
  }

  private emit(eruptedSite: TileRef | null): void {
    this.mg?.addUpdate({
      type: GameUpdateType.Cataclysm,
      kind: "volcano",
      sites: [...this.sites],
      rumblingSite: this.rumblingSite,
      eruptionTick: this.eruptionTick,
      eruptedSite,
    });
  }

  viewResync(): void {
    this.emit(null);
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    // Starts at tick 0 so the sites show while players pick a spawn; the
    // schedule itself waits for the spawn phase to end.
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return VolcanoExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== null,
      manualSites:
        this.manualSites === null
          ? null
          : this.manualSites.map(({ x, y }) => ({ x, y })),
      random: w.random(this.random),
      sites: w.tiles(this.sites),
      nextRumbleTick: this.nextRumbleTick,
      rumblingSite: this.rumblingSite,
      eruptionTick: this.eruptionTick,
      fallout: this.fallout.map((b) => ({
        until: b.until,
        tiles: w.tiles(b.tiles),
      })),
    });
  }

  restoreSnapshot(s: VolcanoState, r: SnapshotReader): void {
    this.active = s.active;
    this.mg = s.initialized ? r.game : null;
    this.manualSites =
      s.manualSites === null
        ? null
        : s.manualSites.map(({ x, y }) => ({ x, y }));
    this.random = r.random(s.random);
    this.sites = Array.from(s.sites);
    this.nextRumbleTick = s.nextRumbleTick;
    this.rumblingSite = s.rumblingSite;
    this.eruptionTick = s.eruptionTick;
    this.fallout = s.fallout.map((b) => ({
      until: b.until,
      tiles: Array.from(b.tiles),
    }));
    if (s.initialized) volcanoes.set(r.game, this);
  }
}

const VolcanoStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  manualSites: z.array(z.object({ x: zInt(), y: zInt() })).nullable(),
  random: zRandom(),
  sites: zTiles(),
  nextRumbleTick: zInt().nullable(),
  rumblingSite: zTile().nullable(),
  eruptionTick: zInt(),
  fallout: z.array(z.object({ until: zInt(), tiles: zTiles() })),
});
type VolcanoState = z.infer<typeof VolcanoStateSchema>;

export const VolcanoExecutionSnapshot = execSnapshotType({
  name: "Volcano",
  version: 1,
  schema: VolcanoStateSchema,
  cls: () => VolcanoExecution,
});
