/**
 * The attack forecast in the hover card: shown for enemy and unclaimed land
 * I could attack, priced with my attack-ratio troops and my front with the
 * tile's owner, in at most three short lines. The numbers themselves are
 * the engine's (tests/AttackForecast.test.ts); here the forecast is stubbed.
 */

const forecastMock = vi.hoisted(() => ({
  result: {
    lossPerTile: 123,
    tilesPerSecond: 4.25 as number | null,
    defensePostLevel: 0,
    siegeReduced: false,
  },
  calls: [] as unknown[][],
  fronts: new Map<number, number>([
    [2, 40],
    [0, 12],
  ]),
}));

vi.mock("@openfront/engine-lib/game/AttackForecast", () => ({
  attackForecast: vi.fn((...args: unknown[]) => {
    forecastMock.calls.push(args);
    return forecastMock.result;
  }),
  attackFrontSizes: vi.fn(() => forecastMock.fronts),
}));

vi.mock("lit", () => ({
  html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  LitElement: class extends EventTarget {
    requestUpdate() {}
  },
  nothing: "",
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: unknown) => clazz,
  state: () => () => {},
  property: () => () => {},
  query: () => () => {},
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn(
    (key: string, params?: Record<string, string>) =>
      key + (params ? JSON.stringify(params) : ""),
  ),
  renderDuration: vi.fn(() => ""),
  getTranslatedPlayerTeamLabel: vi.fn(() => ""),
  getSvgAspectRatio: vi.fn(() => 1),
  formatKeyForDisplay: vi.fn(() => "F"),
}));

vi.mock("../../../../src/client/hud/PlayerIcons", () => ({
  EMOJI_ICON_KIND: "emoji",
  IMAGE_ICON_KIND: "image",
  getFirstPlacePlayer: vi.fn(() => null),
  getPlayerIcons: vi.fn(() => []),
}));

import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerInfoOverlay } from "../../../../src/client/hud/layers/PlayerInfoOverlay";

function flatten(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node === "object" && "strings" in (node as object)) {
    const { strings, values } = node as {
      strings: readonly string[];
      values: unknown[];
    };
    return strings.map((s, i) => s + flatten(values[i])).join("");
  }
  if (typeof node === "object") return "";
  return String(node);
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("PlayerInfoOverlay attack forecast", () => {
  let overlay: PlayerInfoOverlay;

  const enemy = {
    isPlayer: () => true,
    profile: () => Promise.resolve(null),
    getTraitorRemainingTicks: () => 0,
    outgoingAttacks: () => [],
    troops: () => 100,
    gold: () => 0n,
    type: () => PlayerType.Human,
    team: () => null,
    displayName: () => "Bob",
    cosmetics: {},
    id: () => "bob",
    smallID: () => 2,
  };
  const terraNullius = { isPlayer: () => false, smallID: () => 0 };

  function me(friendly = false) {
    return {
      isFriendly: () => friendly,
      isAlliedWith: () => false,
      isAlive: () => true,
      smallID: () => 1,
      troops: () => 50_000,
      borderTiles: async () => ({ borderTiles: new Set([1, 2, 3]) }),
    };
  }

  function game(owner: unknown, myPlayer: unknown, over: object = {}) {
    return {
      isValidCoord: () => true,
      ref: () => 42,
      x: () => 5,
      y: () => 5,
      units: () => [],
      owner: () => owner,
      myPlayer: () => myPlayer,
      inSpawnPhase: () => false,
      isLand: () => true,
      isImpassable: () => false,
      // No unclaimed ruins near the cursor (world features).
      ruins: () => [],
      config: () => ({
        isUnitDisabled: () => true,
        maxTroops: () => 1000,
        isReplay: () => false,
        gameConfig: () => ({}),
      }),
      teamClanTag: () => undefined,
      ...over,
    };
  }

  beforeEach(() => {
    forecastMock.calls.length = 0;
    forecastMock.result = {
      lossPerTile: 123,
      tilesPerSecond: 4.25,
      defensePostLevel: 0,
      siegeReduced: false,
    };
    overlay = new PlayerInfoOverlay();
    overlay.eventBus = { on: vi.fn() } as never;
    overlay.transform = {
      screenToWorldCoordinates: () => ({ x: 5, y: 5 }),
    } as never;
    overlay.uiState = { attackRatio: 0.2 } as never;
    overlay.init();
  });

  async function hover(g: unknown): Promise<string> {
    overlay.game = g as never;
    overlay.maybeShow(10, 10);
    // The front sizes arrive from the worker; the card then refreshes.
    await flush();
    return flatten(overlay.render());
  }

  it("prices enemy land with my attack-ratio troops and my front with them", async () => {
    const out = await hover(game(enemy, me()));
    expect(out).toContain("Bob");
    expect(out).toContain('attack_forecast.loss{"troops":"12"}');
    expect(out).toContain('attack_forecast.speed{"speed":"4.3"}');
    expect(out).not.toContain("attack_forecast.defense_post");
    const last = forecastMock.calls[forecastMock.calls.length - 1];
    // game, attacker, defender, tile, troops, front
    expect(last[2]).toBe(enemy);
    expect(last[3]).toBe(42);
    expect(last[4]).toBe(50_000 * 0.2);
    expect(last[5]).toBe(40);
  });

  it("shows a card with just the forecast for unclaimed land", async () => {
    const out = await hover(game(terraNullius, me()));
    expect(out).toContain("opacity-100 visible");
    expect(out).toContain("attack_forecast.loss");
    const last = forecastMock.calls[forecastMock.calls.length - 1];
    expect(last[2]).toBeNull();
    expect(last[5]).toBe(12);
  });

  it("names the covering defense post's level, and a siege camp's reduction", async () => {
    forecastMock.result = { ...forecastMock.result, defensePostLevel: 2 };
    let out = await hover(game(enemy, me()));
    expect(out).toContain('attack_forecast.defense_post{"level":"2"}');
    forecastMock.result = { ...forecastMock.result, siegeReduced: true };
    overlay.maybeShow(10, 10);
    out = flatten(overlay.render());
    expect(out).toContain('attack_forecast.defense_post_reduced{"level":"2"}');
  });

  it("keeps one decimal on small losses", async () => {
    forecastMock.result = { ...forecastMock.result, lossPerTile: 45 };
    expect(await hover(game(enemy, me()))).toContain(
      'attack_forecast.loss{"troops":"4.5"}',
    );
  });

  it("leaves out the speed until my front is known", async () => {
    forecastMock.result = { ...forecastMock.result, tilesPerSecond: null };
    const out = await hover(game(enemy, me()));
    expect(out).toContain("attack_forecast.loss");
    expect(out).not.toContain("attack_forecast.speed");
  });

  it("shows nothing for a friend, my own land, water, or a player I don't border", async () => {
    const friendOut = await hover(game(enemy, me(true)));
    expect(friendOut).toContain("Bob");
    expect(friendOut).not.toContain("attack_forecast");

    const mine = { ...enemy, ...me(), displayName: () => "Me" };
    const mineOut = await hover(game(mine, mine));
    expect(mineOut).toContain("Me");
    expect(mineOut).not.toContain("attack_forecast");

    expect(
      await hover(game(terraNullius, me(), { isLand: () => false })),
    ).not.toContain("attack_forecast");

    const stranger = { ...enemy, smallID: () => 9 };
    expect(await hover(game(stranger, me()))).not.toContain("attack_forecast");
  });

  it("shows nothing in the spawn phase or without the attack ratio", async () => {
    expect(
      await hover(game(enemy, me(), { inSpawnPhase: () => true })),
    ).not.toContain("attack_forecast");
    overlay.uiState = undefined;
    expect(await hover(game(enemy, me()))).not.toContain("attack_forecast");
  });
});
