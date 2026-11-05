import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  packResourceSites,
  placeResourceSites,
  RESOURCE_SITE_INFO,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITES_RESEND_TICKS,
  ResourceSite,
} from "@openfront/engine-lib/game/ResourceSites";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game } from "../game/Game";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import {
  cityStateZones,
  overlapsZone,
  volcanoZones,
} from "../game/StartPlacements";
import { volcanoSitesOf } from "./VolcanoExecution";

/**
 * Resource sites (rules in engine-lib/game/ResourceSites.ts): places them at
 * game start and pays whoever holds each one, every tick after the spawn
 * phase. GameRunner adds it when GameConfig.resourceSites is on.
 *
 * The sites come from their own random stream off the game id, so they don't
 * shift any other draw. They are announced to the view when placed and every
 * RESOURCE_SITES_RESEND_TICKS after, which also covers a view that starts
 * from a snapshot.
 */

/** Added to the game id's hash for the placement stream (sites' own seed). */
const RESOURCE_SITE_SEED_SALT = 0x51735;

/**
 * Each game's sites, for code that only has the game (nation targeting).
 * The execution owns them and its snapshot holds them; restore re-registers.
 */
const sitesByGame = new WeakMap<Game, readonly ResourceSite[]>();

/** The game's resource sites; empty when the setting is off. */
export function resourceSitesOf(game: Game): readonly ResourceSite[] {
  return sitesByGame.get(game) ?? [];
}

export class ResourceSiteExecution implements Execution {
  private active = true;
  private mg: Game;
  private sites: ResourceSite[] = [];

  constructor(private gameID: GameID) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    const random = new PseudoRandom(
      simpleHash(this.gameID) + RESOURCE_SITE_SEED_SALT,
    );
    const spawnCells = mg
      .nations()
      .map((n) => n.spawnCell)
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    // City-states and volcanoes came first: no mine in a city-state's disc
    // or a volcano's ring (StartPlacements).
    const taken = [...cityStateZones(mg), ...volcanoZones(volcanoSitesOf(mg))];
    this.sites = placeResourceSites(mg.map(), random, spawnCells, (tile) =>
      overlapsZone(mg, taken, tile),
    );
    sitesByGame.set(mg, this.sites);
    this.announce();
  }

  tick(ticks: number): void {
    if (ticks % RESOURCE_SITES_RESEND_TICKS === 0) this.announce();
    if (this.mg.inSpawnPhase()) return;
    const config = this.mg.config();
    for (const site of this.sites) {
      if (!this.mg.isLand(site.tile)) continue;
      const owner = this.mg.owner(site.tile);
      if (!owner.isPlayer()) continue;
      const gold = config.resourceSiteGold(
        owner,
        RESOURCE_SITE_INFO[site.kind].goldPerTick,
      );
      owner.addGold(gold);
      this.mg.stats().goldWork(owner, gold);
    }
  }

  private announce(): void {
    this.mg.addUpdate({
      type: GameUpdateType.ResourceSites,
      sites: packResourceSites(this.sites),
    });
  }

  isActive(): boolean {
    return this.active;
  }

  activeDuringSpawnPhase(): boolean {
    // Placed and shown during the spawn phase, so players can spawn by one.
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ResourceSiteExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      gameID: this.gameID,
      sites: this.sites.map((s) => ({
        tile: s.tile,
        kind: RESOURCE_SITE_KINDS.indexOf(s.kind),
      })),
    });
  }

  restoreSnapshot(s: ResourceSiteState, r: SnapshotReader): void {
    this.active = s.active;
    this.gameID = s.gameID;
    this.sites = s.sites.map((site) => ({
      tile: site.tile,
      kind: RESOURCE_SITE_KINDS[site.kind],
    }));
    if (s.initialized) {
      this.mg = r.game;
      sitesByGame.set(r.game, this.sites);
    }
  }
}

const ResourceSiteStateSchema = z.object({
  active: z.boolean(),
  initialized: z.boolean(),
  gameID: z.string(),
  sites: z.array(
    z.object({
      tile: zTile(),
      // An index into RESOURCE_SITE_KINDS.
      kind: zInt()
        .nonnegative()
        .max(RESOURCE_SITE_KINDS.length - 1),
    }),
  ),
});
type ResourceSiteState = z.infer<typeof ResourceSiteStateSchema>;

export const ResourceSiteExecutionSnapshot = execSnapshotType({
  name: "ResourceSite",
  version: 1,
  schema: ResourceSiteStateSchema,
  cls: () => ResourceSiteExecution,
});
