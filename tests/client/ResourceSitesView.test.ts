import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { GameMapImpl } from "@openfront/engine-lib/game/GameMapImpl";
import {
  packResourceSites,
  ResourceSite,
  ResourceSiteKind,
} from "@openfront/engine-lib/game/ResourceSites";
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { EconomyOverlaySync } from "../../src/client/EconomyOverlaySync";
import { columnById } from "../../src/client/hud/layers/lib/StatsColumns";
import {
  renderResourceSiteCard,
  resourceSiteUnderCursor,
} from "../../src/client/hud/layers/ResourceSiteCard";
import type { MapRenderer } from "../../src/client/render/gl";
import { resourceSiteRadius } from "../../src/client/render/gl/passes/ResourceSitePass";
import type { GameView, PlayerView } from "../../src/client/view";
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
  { tile: 40, kind: ResourceSiteKind.GoldMine },
  { tile: 50, kind: ResourceSiteKind.GoldMine },
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
    // 30 gold a tick, 600 ticks a minute.
    expect(heldResourceSites(game, 1)).toEqual({
      count: 2,
      goldPerMinute: 36_000,
    });
    expect(heldResourceSites(game, 2)).toEqual({
      count: 1,
      goldPerMinute: 18_000,
    });
    expect(siteGoldPerSecond(game, SITES[0])).toBe(300);
  });

  it("pays a holder for their best 3 sites only", () => {
    const { game, send } = stubGame({ 10: 1, 20: 1, 30: 1, 40: 1, 50: 2 });
    send(SITES);
    expect(heldResourceSites(game, 1)).toEqual({
      count: 4,
      goldPerMinute: 54_000,
    });
  });

  it("shows no income for a tribe or city-state holding a site", () => {
    const { game, send } = stubGame({ 10: 1 });
    send(SITES);
    expect(heldResourceSites(game, 1, PlayerType.Bot)).toEqual({
      count: 1,
      goldPerMinute: 0,
    });
    expect(heldResourceSites(game, 1, PlayerType.Nation).goldPerMinute).toBe(
      18_000,
    );
  });

  it("scales the income with the game's gold multiplier", () => {
    const { game, send } = stubGame({ 10: 1 }, 2);
    send(SITES);
    expect(heldResourceSites(game, 1).goldPerMinute).toBe(36_000);
  });

  it("keeps the latest list", () => {
    const { game, send } = stubGame({});
    send(SITES);
    send(SITES.slice(0, 1));
    expect(resourceSitesOf(game)).toEqual(SITES.slice(0, 1));
  });
});

/**
 * A 31x31 ocean on a real GameMapImpl: fishing grounds in the middle with
 * coast 4 tiles south and 6 west, an oil field and a mine in the corners.
 */
function coastGame() {
  const size = 31;
  const ref = (x: number, y: number) => y * size + x;
  const tiles = {
    fishing: ref(15, 15),
    south: ref(15, 19),
    west: ref(9, 15),
    oil: ref(2, 2),
    mine: ref(28, 28),
  };
  const terrain = new Uint8Array(size * size).fill(0x20);
  for (const t of [tiles.south, tiles.west, tiles.oil, tiles.mine]) {
    terrain[t] = 0x80;
  }
  const map = new GameMapImpl(size, size, terrain, 4);
  const sites: ResourceSite[] = [
    { tile: tiles.mine, kind: ResourceSiteKind.GoldMine },
    { tile: tiles.oil, kind: ResourceSiteKind.OilField },
    { tile: tiles.fishing, kind: ResourceSiteKind.FishingGrounds },
  ];
  const names: Record<number, string> = { 1: "alice", 2: "bob" };
  const game = Object.assign(map, {
    updatesSinceLastTick: () => ({
      [GameUpdateType.ResourceSites]: [
        { type: GameUpdateType.ResourceSites, sites: packResourceSites(sites) },
      ],
    }),
    config: () => ({ gameConfig: () => ({}) }),
    owner: (
      t: number,
    ): { isPlayer: () => boolean; displayName?: () => string } => {
      const id = map.ownerID(t);
      return id === 0
        ? { isPlayer: () => false }
        : { isPlayer: () => true, displayName: () => names[id] };
    },
  }) as unknown as GameView;
  absorbResourceSites(game);
  return { map, game, tiles, sites };
}

const player = (smallID: number, type = PlayerType.Human) =>
  ({ smallID: () => smallID, type: () => type }) as PlayerView;

describe("fishing grounds and oil fields on the client", () => {
  it("count fishing grounds for whoever holds the nearest coast", () => {
    const { map, game, tiles } = coastGame();
    map.setOwnerID(tiles.south, 1);
    map.setOwnerID(tiles.west, 2);
    expect(heldResourceSites(game, 1)).toEqual({
      count: 1,
      goldPerMinute: 18_000,
    });
    expect(heldResourceSites(game, 2)).toEqual({ count: 0, goldPerMinute: 0 });
    // The south coast floods: the west coast is nearest now.
    map.setOwnerID(tiles.south, 0);
    map.setWater(tiles.south);
    expect(heldResourceSites(game, 1).count).toBe(0);
    expect(heldResourceSites(game, 2)).toEqual({
      count: 1,
      goldPerMinute: 18_000,
    });
  });

  it("an unowned nearest coast pays no one", () => {
    const { map, game, tiles } = coastGame();
    map.setOwnerID(tiles.west, 2);
    expect(heldResourceSites(game, 2).count).toBe(0);
  });

  it("an oil field pays 45 gold a tick", () => {
    const { map, game, tiles, sites } = coastGame();
    map.setOwnerID(tiles.oil, 1);
    expect(heldResourceSites(game, 1)).toEqual({
      count: 1,
      goldPerMinute: 27_000,
    });
    expect(siteGoldPerSecond(game, sites[1])).toBe(450);
  });

  it("the leaderboard's site columns count every kind", () => {
    const { map, game, tiles } = coastGame();
    for (const t of [tiles.mine, tiles.oil, tiles.south]) {
      map.setOwnerID(t, 1);
    }
    expect(columnById("mines").value!(player(1), game)).toBe(3);
    // (30 + 45 + 30) gold a tick, 600 ticks a minute.
    expect(columnById("mineGoldPerMin").value!(player(1), game)).toBe(63_000);
    expect(columnById("mines").value!(player(2), game)).toBe(0);
    // A tribe holding them is paid nothing.
    expect(
      columnById("mineGoldPerMin").value!(player(1, PlayerType.Bot), game),
    ).toBe(0);
  });

  it("hovering the water shows the fishing grounds and their coast's holder", () => {
    const { map, game, tiles, sites } = coastGame();
    const near = map.ref(16, 14);
    expect(resourceSiteUnderCursor(game, near)).toEqual(sites[2]);
    const card = () => {
      const el = document.createElement("div");
      render(renderResourceSiteCard(game, sites[2]), el);
      return el.textContent ?? "";
    };
    expect(card()).toContain("resource_sites.fishing_grounds");
    expect(card()).toContain("resource_sites.unclaimed_coast");
    map.setOwnerID(tiles.south, 1);
    expect(card()).toContain("resource_sites.held_by");
    // A mine dug out of the land is gone.
    map.setWater(tiles.mine);
    expect(resourceSiteUnderCursor(game, tiles.mine)).toBeNull();
  });
});

describe("sites that appear once the spawn phase is over", () => {
  it("draw nothing until the engine places them, then every site", () => {
    const size = 31;
    const terrain = new Uint8Array(size * size).fill(0x80);
    const map = new GameMapImpl(size, size, terrain, size * size);
    const sites: ResourceSite[] = [
      { tile: map.ref(5, 5), kind: ResourceSiteKind.GoldMine },
      { tile: map.ref(25, 25), kind: ResourceSiteKind.OilField },
    ];
    let updates: unknown = null;
    type OwnerStub = {
      isPlayer: () => boolean;
      smallID?: () => number;
      territoryColor?: () => { toRgb: () => object };
    };
    const game = Object.assign(map, {
      updatesSinceLastTick: () => updates,
      owner: (t: number): OwnerStub =>
        map.ownerID(t) === 0
          ? { isPlayer: () => false }
          : {
              isPlayer: () => true,
              smallID: () => map.ownerID(t),
              territoryColor: () => ({ toRgb: () => ({ r: 255, g: 0, b: 0 }) }),
            },
    }) as unknown as GameView;
    const updateResourceSites = vi.fn();
    const view = { updateResourceSites } as unknown as MapRenderer;
    const sync = new EconomyOverlaySync();

    // The spawn phase: no update carries sites, so nothing is drawn.
    for (let i = 0; i < 5; i++) sync.sync(game, view);
    expect(resourceSitesOf(game)).toEqual([]);
    expect(updateResourceSites.mock.calls.every(([m]) => m.length === 0)).toBe(
      true,
    );

    // The engine places them after the spawn phase.
    updates = {
      [GameUpdateType.ResourceSites]: [
        { type: GameUpdateType.ResourceSites, sites: packResourceSites(sites) },
      ],
    };
    sync.sync(game, view);
    expect(resourceSitesOf(game)).toEqual(sites);
    expect(updateResourceSites).toHaveBeenLastCalledWith([
      expect.objectContaining({ x: 5, y: 5, kind: 0, owned: false }),
      expect.objectContaining({ x: 25, y: 25, kind: 1, owned: false }),
    ]);

    // Later ticks keep them, and a capture re-sends them.
    const sent = updateResourceSites.mock.calls.length;
    updates = null;
    sync.sync(game, view);
    expect(updateResourceSites.mock.calls.length).toBe(sent);
    map.setOwnerID(sites[0].tile, 3);
    sync.sync(game, view);
    expect(updateResourceSites).toHaveBeenLastCalledWith([
      expect.objectContaining({ x: 5, y: 5, owned: true }),
      expect.objectContaining({ x: 25, y: 25, owned: false }),
    ]);
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
