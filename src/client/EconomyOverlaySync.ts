import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  RESOURCE_SITE_KINDS,
  resourceSiteHolderTile,
  resourceSiteStands,
} from "@openfront/engine-lib/game/ResourceSites";
// Type-only, like WebGLFrameBuilder's: a value import would pull the passes'
// `.glsl?raw` shaders into non-Vite consumers.
import type { MapRenderer } from "./render/gl";
import type { CanalMarker } from "./render/gl/passes/CanalPass";
import type { ResourceSiteMarker } from "./render/gl/passes/ResourceSitePass";
import type { GameView } from "./view";
import { absorbResourceSites, resourceSitesOf } from "./view/ResourceSitesView";

/**
 * Feeds the renderer the resource sites (ResourceSitePass) and the canals
 * being dug (CanalPass). WebGLFrameBuilder runs it once per tick. Sites are
 * re-sent only when one changes hands; digs every tick while any exist,
 * since their progress moves.
 */
export class EconomyOverlaySync {
  private lastSitesKey = "";
  private hadCanals = false;

  /** Forget what was sent, so the next sync re-sends everything. */
  clear(): void {
    this.lastSitesKey = "";
    this.hadCanals = false;
  }

  sync(gameView: GameView, view: MapRenderer): void {
    this.syncSites(gameView, view);
    this.syncCanals(gameView, view);
  }

  private syncSites(gameView: GameView, view: MapRenderer): void {
    absorbResourceSites(gameView);
    const markers: ResourceSiteMarker[] = [];
    let key = "";
    for (const s of resourceSitesOf(gameView)) {
      // Dug out by a canal or a water nuke: nothing left to hold.
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

  private syncCanals(gameView: GameView, view: MapRenderer): void {
    const digs = gameView.units(UnitType.Canal);
    if (digs.length === 0 && !this.hadCanals) return;
    this.hadCanals = digs.length > 0;

    const duration =
      gameView.config().unitInfo(UnitType.Canal).constructionDuration ?? 0;
    const markers: CanalMarker[] = [];
    for (const dig of digs) {
      const start = dig.tile();
      const end = dig.targetTile() ?? start;
      const sx = gameView.x(start);
      const sy = gameView.y(start);
      const ex = gameView.x(end);
      const ey = gameView.y(end);
      // The second row, as engine-lib/game/Canal.ts lays it.
      const xMajor = Math.abs(ex - sx) >= Math.abs(ey - sy);
      const startTick = dig.state.constructionStartTick;
      const progress =
        !dig.isUnderConstruction() || duration <= 0 || startTick === null
          ? 1
          : Math.min(1, Math.max(0, (gameView.ticks() - startTick) / duration));
      const c = dig.owner().territoryColor().toRgb();
      markers.push({
        startX: sx,
        startY: sy,
        endX: ex,
        endY: ey,
        offsetX: xMajor ? 0 : 1,
        offsetY: xMajor ? 1 : 0,
        r: c.r / 255,
        g: c.g / 255,
        b: c.b / 255,
        progress,
      });
    }
    view.updateCanals(markers);
  }
}
