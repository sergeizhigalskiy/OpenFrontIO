import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { renderTroops } from "@openfront/engine-lib/Format";
import { euclDistFN } from "@openfront/engine-lib/game/GameMapImpl";
import {
  HORDE_BAND_LANDING_RADIUS,
  HORDE_BAND_MIN_SPACING,
  HORDE_BAND_PLACEMENT_TRIES,
  HORDE_TEAM,
  hordeBandCount,
  hordeBandTroops,
  hordeWavesLanded,
  isHordeBand,
  isHordeDefender,
} from "@openfront/engine-lib/game/HordeNight";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zRandom } from "@openfront/engine-lib/snapshot/SnapshotType";
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

// Distinct from the seeds of createGameRunner (+0), the Executor (+1) and
// TribeSpawner (+2), so band ids don't follow theirs.
const HORDE_SEED_OFFSET = 3;

/**
 * Horde Night's wave clock (see engine-lib/game/HordeNight.ts). On schedule
 * it lands each wave: 2 + wave bands sharing the wave's troop pool, each on
 * its own patch of map edge or coast, free land first. Each band is a bot on
 * HORDE_TEAM with a PlayerExecution (so pocket annexation and death work as
 * for anyone) and a HordeBandExecution.
 */
export class HordeNightExecution implements Execution {
  private active = true;
  private mg: Game;
  private random: PseudoRandom;
  private wavesLanded = 0;

  /** `seed` is the game id. */
  constructor(seed: string) {
    this.random = new PseudoRandom(simpleHash(seed) + HORDE_SEED_OFFSET);
  }

  activeDuringSpawnPhase(): boolean {
    return false;
  }

  init(mg: Game): void {
    this.mg = mg;
  }

  tick(): void {
    if (this.mg.getWinner() !== null) {
      this.active = false;
      return;
    }
    const ticksSinceStart = Math.round(this.mg.elapsedGameSeconds() * 10);
    while (this.wavesLanded < hordeWavesLanded(ticksSinceStart)) {
      this.wavesLanded++;
      this.landWave(this.wavesLanded);
    }
  }

  /** Waves landed so far. */
  waves(): number {
    return this.wavesLanded;
  }

  private landWave(wave: number): void {
    const defenders = this.mg.players().filter(isHordeDefender).length;
    const troops = hordeBandTroops(wave, defenders);
    const sites = this.landingSites(hordeBandCount(wave));
    let landed = 0;
    for (const site of sites) {
      if (this.landBand(site, troops, `Horde ${wave}-${landed + 1}`)) landed++;
    }
    this.mg.displayMessage(
      "events_display.horde_wave_landed",
      MessageType.NAVAL_INVASION_INBOUND,
      null,
      undefined,
      { wave, bands: landed, troops: renderTroops(troops * landed) },
    );
  }

  /**
   * Up to `count` passable land tiles on the map edge or a coast, not held by
   * a band. Free land first and spread out; then land players hold; then
   * the spacing is dropped.
   */
  landingSites(count: number): TileRef[] {
    const map = this.mg.map();
    const free: TileRef[] = [];
    const held: TileRef[] = [];
    map.forEachTile((tile) => {
      if (!map.isLand(tile) || map.isImpassable(tile)) return;
      if (!map.isShore(tile) && !map.isOnEdgeOfMap(tile)) return;
      const owner = map.ownerID(tile);
      if (owner === 0) {
        if (!map.hasFallout(tile)) free.push(tile);
        return;
      }
      if (!isHordeBand(this.mg.playerBySmallID(owner) as Player)) {
        held.push(tile);
      }
    });
    const sites: TileRef[] = [];
    for (const [pool, spacing] of [
      [free, HORDE_BAND_MIN_SPACING],
      [held, HORDE_BAND_MIN_SPACING],
      [free, 0],
      [held, 0],
    ] as const) {
      this.pickSpaced(pool, spacing, count, sites);
    }
    return sites;
  }

  private pickSpaced(
    pool: TileRef[],
    spacing: number,
    count: number,
    sites: TileRef[],
  ): void {
    if (pool.length === 0) return;
    const spacing2 = spacing * spacing;
    for (
      let tries = 0;
      sites.length < count && tries < HORDE_BAND_PLACEMENT_TRIES * count;
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

  // Lands one band on the passable land around `site` that no band holds.
  private landBand(site: TileRef, troops: number, name: string): boolean {
    const map = this.mg.map();
    const tiles: TileRef[] = [];
    this.mg
      .bfs(site, euclDistFN(site, HORDE_BAND_LANDING_RADIUS, true))
      .forEach((tile) => {
        if (!map.isLand(tile) || map.isImpassable(tile)) return;
        const owner = map.ownerID(tile);
        if (
          owner !== 0 &&
          isHordeBand(this.mg.playerBySmallID(owner) as Player)
        )
          return;
        tiles.push(tile);
      });
    if (tiles.length === 0) return false;

    let id = this.random.nextID();
    while (this.mg.hasPlayer(id)) id = this.random.nextID();
    const band = this.mg.addPlayer(
      new PlayerInfo(name, PlayerType.Bot, null, id),
      HORDE_TEAM,
    );
    for (const tile of tiles) band.conquer(tile);
    band.setSpawnTile(tiles.includes(site) ? site : tiles[0]);
    band.setTroops(troops);
    this.mg.addExecution(
      new PlayerExecution(band),
      new HordeBandExecution(band),
    );
    return true;
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
    });
  }

  restoreSnapshot(s: HordeNightState, r: SnapshotReader): void {
    this.active = s.active;
    if (s.initialized) this.mg = r.game;
    this.random = r.random(s.random);
    this.wavesLanded = s.wavesLanded;
  }
}

const HordeNightStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  random: zRandom(),
  wavesLanded: zInt(),
});
type HordeNightState = z.infer<typeof HordeNightStateSchema>;

export const HordeNightExecutionSnapshot = execSnapshotType({
  name: "HordeNight",
  version: 1,
  schema: HordeNightStateSchema,
  cls: () => HordeNightExecution,
});
