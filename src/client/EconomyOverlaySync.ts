import {
  RESOURCE_SITE_KINDS,
  resourceSiteHolderTile,
  resourceSiteStands,
} from "@openfront/engine-lib/game/ResourceSites";
// Type-only, like WebGLFrameBuilder's: a value import would pull the passes'
// `.glsl?raw` shaders into non-Vite consumers.
import type { MapRenderer } from "./render/gl";
import type { ResourceSiteMarker } from "./render/gl/passes/ResourceSitePass";
import type { GameView } from "./view";
import { absorbResourceSites, resourceSitesOf } from "./view/ResourceSitesView";

/**
 * Feeds the renderer the resource sites (ResourceSitePass). WebGLFrameBuilder
 * runs it once per tick. Sites are re-sent only when one changes hands.
 */
export class EconomyOverlaySync {
  private lastSitesKey = "";

  /** Forget what was sent, so the next sync re-sends everything. */
  clear(): void {
    this.lastSitesKey = "";
  }

  sync(gameView: GameView, view: MapRenderer): void {
    this.syncSites(gameView, view);
  }

  private syncSites(gameView: GameView, view: MapRenderer): void {
    absorbResourceSites(gameView);
    const markers: ResourceSiteMarker[] = [];
    let key = "";
    for (const s of resourceSitesOf(gameView)) {
      // Its tile turned to water: nothing left to hold.
      if (!resourceSiteStands(gameView, s)) continue;
      // Its tile's owner, or for fishing grounds the nearest coast's.
      const holder = resourceSiteHolderTile(gameView, s);
      const owner = holder === null ? null : gameView.owner(holder);
      const held = owner !== null && owner.isPlayer();
      key += `${s.tile}:${held ? owner.smallID() : 0},`;
      const c = held ? owner.territoryColor().toRgb() : { r: 0, g: 0, b: 0 };
      markers.push({
        x: gameView.x(s.tile),
        y: gameView.y(s.tile),
        kind: RESOURCE_SITE_KINDS.indexOf(s.kind),
        owned: held,
        r: c.r / 255,
        g: c.g / 255,
        b: c.b / 255,
      });
    }
    if (key === this.lastSitesKey) return;
    this.lastSitesKey = key;
    view.updateResourceSites(markers);
  }
}
