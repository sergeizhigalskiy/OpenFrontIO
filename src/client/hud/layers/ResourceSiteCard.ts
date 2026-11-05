import { TileRef } from "@openfront/engine-api/game/GameMap";
import { renderNumber } from "@openfront/engine-lib/Format";
import {
  RESOURCE_SITE_INFO,
  ResourceSite,
  resourceSiteNear,
} from "@openfront/engine-lib/game/ResourceSites";
import { html, TemplateResult } from "lit";
import { translateText } from "../../Utils";
import type { GameView } from "../../view";
import {
  resourceSitesOf,
  siteGoldPerSecond,
} from "../../view/ResourceSitesView";

/** Tiles from a site's center that still count as hovering its icon. */
const SITE_HOVER_RADIUS = 4;

/** The resource site whose icon is under `tile`, or null. */
export function resourceSiteUnderCursor(
  game: GameView,
  tile: TileRef,
): ResourceSite | null {
  const site = resourceSiteNear(
    game,
    resourceSitesOf(game),
    tile,
    SITE_HOVER_RADIUS,
  );
  // A site dug out of the land is no longer drawn.
  return site !== null && game.isLand(site.tile) ? site : null;
}

/** The hover card's lines for a site: its name, holder and income. */
export function renderResourceSiteCard(
  game: GameView,
  site: ResourceSite,
): TemplateResult {
  const owner = game.owner(site.tile);
  const holder = owner.isPlayer()
    ? translateText("resource_sites.held_by", { name: owner.displayName() })
    : translateText("resource_sites.unclaimed");
  const gold = translateText("resource_sites.income", {
    gold: renderNumber(siteGoldPerSecond(game, site)),
  });
  return html`
    <div class="p-2 border-b border-white/10">
      <div class="font-bold text-yellow-300">
        ${translateText(RESOURCE_SITE_INFO[site.kind].nameKey)}
      </div>
      <div class="text-sm">${holder}</div>
      <div class="text-sm opacity-80">${gold}</div>
    </div>
  `;
}
