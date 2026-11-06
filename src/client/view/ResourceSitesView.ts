import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  paidByResourceSites,
  RESOURCE_SITE_INFO,
  ResourceSite,
  resourceSitesGoldPerTick,
  resourceSitesHeldBy,
  unpackResourceSites,
} from "@openfront/engine-lib/game/ResourceSites";
import type { GameView } from "./GameView";

/**
 * The client's copy of the game's resource sites (engine-lib/game/
 * ResourceSites.ts). The engine sends the full list in a ResourceSitesUpdate
 * when it places them, once the spawn phase is over, and every second after
 * (until then the list is empty and nothing is drawn). WebGLFrameBuilder
 * calls absorbResourceSites once per tick, and the map icons, the hover and the
 * leaderboard read it back with resourceSitesOf. Who holds a site comes
 * from engine-lib's resourceSiteHolderTile, the same answer the engine pays.
 */

const sitesByGame = new WeakMap<GameView, readonly ResourceSite[]>();

/** Takes the latest site list from this tick's updates, if it carries one. */
export function absorbResourceSites(game: GameView): void {
  const updates = game.updatesSinceLastTick()?.[GameUpdateType.ResourceSites];
  if (updates === undefined || updates.length === 0) return;
  sitesByGame.set(game, unpackResourceSites(updates[updates.length - 1].sites));
}

/** The game's resource sites, empty until the engine has sent them. */
export function resourceSitesOf(game: GameView): readonly ResourceSite[] {
  return sitesByGame.get(game) ?? [];
}

/** The game's gold multiplier, as passive income uses it. */
function goldMultiplier(game: GameView): number {
  return game.config().gameConfig().goldMultiplier ?? 1;
}

/** Gold per second a site of this kind pays its holder. */
export function siteGoldPerSecond(game: GameView, site: ResourceSite): number {
  return (
    Number(RESOURCE_SITE_INFO[site.kind].goldPerTick) *
    goldMultiplier(game) *
    10
  );
}

/**
 * How many sites (of every kind) `smallID` holds and the gold per minute
 * they pay: the best few only (resourceSitesGoldPerTick), and nothing to a
 * tribe or city-state when its `type` is given.
 */
export function heldResourceSites(
  game: GameView,
  smallID: number,
  type?: PlayerType,
): { count: number; goldPerMinute: number } {
  const sites = resourceSitesOf(game);
  if (sites.length === 0) return { count: 0, goldPerMinute: 0 };
  const held = resourceSitesHeldBy(game, sites, smallID);
  if (type !== undefined && !paidByResourceSites(type)) {
    return { count: held.length, goldPerMinute: 0 };
  }
  const perTick = Number(resourceSitesGoldPerTick(held)) * goldMultiplier(game);
  return { count: held.length, goldPerMinute: perTick * 600 };
}
