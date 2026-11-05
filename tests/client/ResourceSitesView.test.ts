import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  packResourceSites,
  ResourceSiteKind,
} from "@openfront/engine-lib/game/ResourceSites";
import { describe, expect, it } from "vitest";
import { resourceSiteRadius } from "../../src/client/render/gl/passes/ResourceSitePass";
import type { GameView } from "../../src/client/view";
import {
  absorbResourceSites,
  heldResourceSites,
  resourceSitesOf,
  siteGoldPerSecond,
} from "../../src/client/view/ResourceSitesView";

const SITES = [
  { tile: 10, kind: ResourceSiteKind.GoldMine },
  { tile: 20, kind: ResourceSiteKind.GoldMine },
  { tile: 30, kind: ResourceSiteKind.GoldMine },
];

/** Just what ResourceSitesView reads from a GameView. */
function stubGame(owners: Record<number, number>, goldMultiplier?: number) {
  let updates: unknown = null;
  const game = {
    updatesSinceLastTick: () => updates,
    isLand: (t: number) => t !== 30 || owners[30] !== -1,
    ownerID: (t: number) => owners[t] ?? 0,
    config: () => ({ gameConfig: () => ({ goldMultiplier }) }),
  };
  const send = (sites: typeof SITES) => {
    updates = {
      [GameUpdateType.ResourceSites]: [
        { type: GameUpdateType.ResourceSites, sites: packResourceSites(sites) },
      ],
    };
    absorbResourceSites(game as unknown as GameView);
  };
  return { game: game as unknown as GameView, send };
}

describe("ResourceSitesView", () => {
  it("has no sites until the engine sends them", () => {
    const { game } = stubGame({});
    absorbResourceSites(game);
    expect(resourceSitesOf(game)).toEqual([]);
    expect(heldResourceSites(game, 1)).toEqual({ count: 0, goldPerMinute: 0 });
  });

  it("counts the mines a player holds and what they pay per minute", () => {
    const { game, send } = stubGame({ 10: 1, 20: 1, 30: 2 });
    send(SITES);
    expect(resourceSitesOf(game)).toEqual(SITES);
    // 75 gold a tick, 600 ticks a minute.
    expect(heldResourceSites(game, 1)).toEqual({
      count: 2,
      goldPerMinute: 90_000,
    });
    expect(heldResourceSites(game, 2)).toEqual({
      count: 1,
      goldPerMinute: 45_000,
    });
    expect(siteGoldPerSecond(game, SITES[0])).toBe(750);
  });

  it("scales the income with the game's gold multiplier", () => {
    const { game, send } = stubGame({ 10: 1 }, 2);
    send(SITES);
    expect(heldResourceSites(game, 1).goldPerMinute).toBe(90_000);
  });

  it("keeps the latest list", () => {
    const { game, send } = stubGame({});
    send(SITES);
    send(SITES.slice(0, 1));
    expect(resourceSitesOf(game)).toEqual(SITES.slice(0, 1));
  });
});

describe("resource site icon size", () => {
  it("stays readable at every zoom", () => {
    // Zoomed out: grows in tiles to keep a minimum on screen.
    expect(resourceSiteRadius(0.5)).toBeGreaterThan(4);
    // Medium zoom: its natural four tiles.
    expect(resourceSiteRadius(3)).toBe(4);
    // Zoomed in: shrinks in tiles so it doesn't cover the screen.
    expect(resourceSiteRadius(20) * 20).toBeLessThanOrEqual(22);
  });
});
