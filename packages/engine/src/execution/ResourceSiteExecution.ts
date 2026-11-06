import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameID } from "@openfront/engine-api/Schemas";
import {
  packResourceSites,
  paidByResourceSites,
  placeResourceSites,
  RESOURCE_SITE_FIRST_PAY_TICKS,
  RESOURCE_SITE_KINDS,
  RESOURCE_SITES_RESEND_TICKS,
  ResourceSite,
  resourceSiteHolderTile,
  resourceSitesGoldPerTick,
} from "@openfront/engine-lib/game/ResourceSites";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { zInt, zTile } from "@openfront/engine-lib/snapshot/SnapshotType";
import { simpleHash } from "@openfront/engine-lib/Util";
import { z } from "zod";
import { Execution, Game, Player } from "../game/Game";
import {
  cityStateZones,
  humanAndNationCount,
  humanAndNationSpawns,
  overlapsZone,
  spawnsSettled,
  volcanoZones,
} from "../game/StartPlacements";
import { execSnapshotType } from "../snapshot/ExecutionSnapshot";
import type {
  ExecRecord,
  SnapshotReader,
  SnapshotWriter,
} from "../snapshot/SnapshotContext";
import { volcanoSitesOf } from "./VolcanoExecution";

/**
 * Resource sites (rules in engine-lib/game/ResourceSites.ts): places them
 * once the spawn phase is over and every spawn has landed (spawnsSettled),
 * away from every human and nation spawn. From RESOURCE_SITE_FIRST_PAY_TICKS
 * after the spawn phase it pays each human or nation holder for their best
 * sites, every tick. GameRunner adds it when GameConfig.resourceSites is on,
 * ahead of the ruins, so ruins placed on the same tick keep clear of the
 * mines (StartPlacements).
 *
 * The sites come from their own random stream off the game id, so they don't
 * shift any other draw. They are announced to the view when placed and every
 * RESOURCE_SITES_RESEND_TICKS after, which also covers a view that starts
 * from a snapshot. Before that the view has none, so nothing shows while
 * players pick a spawn.
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
  // Set once the spawns are settled, when the sites go down.
  private placed = false;

  constructor(private gameID: GameID) {}

  init(mg: Game, ticks: number): void {
    this.mg = mg;
    sitesByGame.set(mg, this.sites);
  }

  tick(ticks: number): void {
    if (!spawnsSettled(this.mg)) return;
    if (!this.placed) {
      this.place();
    } else if (ticks % RESOURCE_SITES_RESEND_TICKS === 0) {
      this.announce();
    }
    if (this.mg.ticksSinceStart() < RESOURCE_SITE_FIRST_PAY_TICKS) return;
    this.pay();
  }

  private place(): void {
    const mg = this.mg;
    const random = new PseudoRandom(
      simpleHash(this.gameID) + RESOURCE_SITE_SEED_SALT,
    );
    // City-states and volcanoes came first: no mine in a city-state's disc
    // or a volcano's ring (StartPlacements).
    const taken = [...cityStateZones(mg), ...volcanoZones(volcanoSitesOf(mg))];
    const spawns = humanAndNationSpawns(mg).map((tile) => ({
      x: mg.x(tile),
      y: mg.y(tile),
    }));
    this.sites = placeResourceSites(
      mg.map(),
      random,
      humanAndNationCount(mg),
      spawns,
      (tile) => overlapsZone(mg, taken, tile),
    );
    this.placed = true;
    sitesByGame.set(mg, this.sites);
    this.announce();
  }

  /** One payment per human or nation holder, for their best sites. */
  private pay(): void {
    const map = this.mg.map();
    // Insertion order (the sites' order) keeps the payments deterministic.
    const held = new Map<Player, ResourceSite[]>();
    for (const site of this.sites) {
      // Its tile, or for fishing grounds the nearest coast's.
      const holder = resourceSiteHolderTile(map, site);
      if (holder === null) continue;
      const owner = this.mg.owner(holder);
      if (!owner.isPlayer() || !paidByResourceSites(owner.type())) continue;
      const sites = held.get(owner);
      if (sites === undefined) held.set(owner, [site]);
      else sites.push(site);
    }
    const config = this.mg.config();
    for (const [owner, sites] of held) {
      const gold = config.resourceSiteGold(
        owner,
        resourceSitesGoldPerTick(sites),
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
    // Inited at game start so it keeps its place ahead of the ruins in the
    // execution order; it does nothing until the spawn phase ends.
    return true;
  }

  snapshot(w: SnapshotWriter): ExecRecord {
    return ResourceSiteExecutionSnapshot.write({
      active: this.active,
      initialized: this.mg !== undefined,
      gameID: this.gameID,
      placed: this.placed,
      sites: this.sites.map((s) => ({
        tile: s.tile,
        kind: RESOURCE_SITE_KINDS.indexOf(s.kind),
      })),
    });
  }

  restoreSnapshot(s: ResourceSiteState, r: SnapshotReader): void {
    this.active = s.active;
    this.gameID = s.gameID;
    this.placed = s.placed;
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
  placed: z.boolean(),
  sites: z.array(
    z.object({
      tile: zTile(),
      // An index into RESOURCE_SITE_KINDS. Kinds are only appended, so a
      // record from an earlier build stays valid as the range grows.
      kind: zInt()
        .nonnegative()
        .max(RESOURCE_SITE_KINDS.length - 1),
    }),
  ),
});
type ResourceSiteState = z.infer<typeof ResourceSiteStateSchema>;

export const ResourceSiteExecutionSnapshot = execSnapshotType({
  name: "ResourceSite",
  // v2 added placed: sites now go down after the spawn phase. A v1
  // execution placed them in init, so an initialized one has them.
  version: 2,
  migrations: {
    1: (d) => {
      const old = d as Record<string, unknown>;
      return { ...old, placed: old.initialized === true };
    },
  },
  schema: ResourceSiteStateSchema,
  cls: () => ResourceSiteExecution,
});
