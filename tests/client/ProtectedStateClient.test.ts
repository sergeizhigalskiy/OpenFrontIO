import { GameMode } from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import {
  PROTECTED_STATE_BADGE,
  PROTECTED_STATE_MODE_NAME,
} from "@openfront/engine-lib/game/ProtectedState";
import { render } from "lit";
import emojiAtlas from "resources/atlases/emoji-atlas-meta.json";
import en from "resources/lang/en.json";
import { describe, expect, it, vi } from "vitest";
import type { GameView, PlayerView } from "../../src/client/view";
import { CataclysmView } from "../../src/client/view/CataclysmView";

vi.mock("../../src/client/Cosmetics", () => ({
  getPlayerCosmetics: vi.fn(async () => ({})),
}));

vi.mock("../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    isOnCrazyGames: vi.fn(() => false),
    requestMidgameAd: vi.fn(async () => {}),
  },
}));

vi.mock("../../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: { getMapData: vi.fn() },
}));

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));

// Side-effect imports so the custom elements register.
import "../../src/client/components/GameConfigSettings";
import "../../src/client/SinglePlayerModal";

const { isProtectedState, leaderboardName, nameBadges, patronsOf } =
  await import("../../src/client/hud/ProtectedStateBadge");
const { notableLobbySettings } =
  await import("../../src/client/utilities/LobbySettingsSummary");

function player(smallID: number, name: string): PlayerView {
  return {
    smallID: () => smallID,
    name: () => name,
    displayName: () => name,
    isPlayer: () => true,
  } as unknown as PlayerView;
}

function gameWith(players: PlayerView[], view: CataclysmView): GameView {
  return {
    cataclysm: () => view,
    playerBySmallID: (id: number) =>
      players.find((p) => p.smallID() === id) ?? { isPlayer: () => false },
  } as unknown as GameView;
}

function protectedStateView(state: number, patrons: number[]): CataclysmView {
  const view = new CataclysmView();
  view.apply([
    { type: GameUpdateType.Cataclysm, kind: "protectedState", state, patrons },
  ]);
  return view;
}

describe("Protected State on the client", () => {
  it("the view keeps the latest state and patrons, and none once it falls", () => {
    const view = protectedStateView(4, [7, 2, 9]);
    expect(view.protectedStateID()).toBe(4);
    expect(view.patronIDs()).toEqual([7, 2, 9]);
    view.apply([
      {
        type: GameUpdateType.Cataclysm,
        kind: "protectedState",
        state: 0,
        patrons: [],
      },
    ]);
    expect(view.protectedStateID()).toBe(0);
    expect(view.patronIDs()).toEqual([]);
    expect(new CataclysmView().protectedStateID()).toBe(0);
  });

  it("badges it on the leaderboard and over its name on the map", () => {
    const small = player(4, "Luxembourg");
    const big = player(7, "France");
    const game = gameWith([small, big], protectedStateView(4, [7]));
    expect(isProtectedState(game, small)).toBe(true);
    expect(isProtectedState(game, big)).toBe(false);
    expect(leaderboardName(game, small)).toBe(
      `${PROTECTED_STATE_BADGE} Luxembourg`,
    );
    expect(leaderboardName(game, big)).toBe("France");
    expect([...nameBadges(game)]).toEqual([[4, PROTECTED_STATE_BADGE]]);
    // The map's name labels draw it from the emoji atlas.
    expect(
      (emojiAtlas as { emojis: Record<string, number> }).emojis[
        PROTECTED_STATE_BADGE
      ],
    ).toBeDefined();
  });

  it("lists the patrons, strongest first, only for the Protected State", () => {
    const small = player(4, "Luxembourg");
    const a = player(7, "France");
    const b = player(2, "Germany");
    const game = gameWith([small, a, b], protectedStateView(4, [7, 2]));
    expect(patronsOf(game, small)).toEqual([a, b]);
    expect(patronsOf(game, a)).toEqual([]);
  });

  it("with the mode off nothing is badged", () => {
    const small = player(4, "Luxembourg");
    const game = gameWith([small], new CataclysmView());
    expect(leaderboardName(game, small)).toBe("Luxembourg");
    expect(nameBadges(game).size).toBe(0);
    expect(patronsOf(game, small)).toEqual([]);
  });

  it("every string takes the mode's name from the one constant", () => {
    const strings = en as unknown as Record<string, Record<string, string>>;
    expect(strings.game_settings.protected_state).toBe("{mode}");
    expect(strings.protected_state.rules).toContain("{mode}");
    expect(strings.events_display.protected_state_named).toBe(
      "{nation} is the {mode}",
    );
    expect(strings.events_display.protected_state_call_to_war).toBe(
      "{nation} called its patrons to war against {target}",
    );
    const summary = notableLobbySettings(
      { protectedState: true } as GameConfig,
      0,
    );
    expect(summary.map((s) => s.label)).toContain(
      `game_settings.protected_state ${JSON.stringify({ mode: PROTECTED_STATE_MODE_NAME })}`,
    );
  });
});

describe("the Protected State lobby toggle", () => {
  function singlePlayer(): { modal: any; starts: any[] } {
    const modal = document.createElement("single-player-modal") as any;
    const starts: any[] = [];
    modal.addEventListener("join-lobby", (e: Event) =>
      starts.push((e as CustomEvent).detail),
    );
    modal.nations = 6;
    return { modal, starts };
  }

  function toggle(modal: any, labelKey: string, checked: boolean): void {
    modal.handleConfigOptionToggleChanged(
      new CustomEvent("option-toggle-changed", {
        detail: { labelKey, checked },
      }),
    );
  }

  it("is off by default and starts the game with it when on", async () => {
    const off = singlePlayer();
    expect(off.modal.protectedState).toBe(false);
    await off.modal.startGame();
    expect(off.starts[0].gameStartInfo.config.protectedState).toBeUndefined();

    const on = singlePlayer();
    toggle(on.modal, "game_settings.protected_state", true);
    await on.modal.startGame();
    expect(on.starts[0].gameStartInfo.config.protectedState).toBe(true);
  });

  it("switches Boss Raid, Horde Night and the plague off, and they switch it off", () => {
    const { modal } = singlePlayer();
    toggle(modal, "game_settings.plague", true);
    toggle(modal, "game_settings.protected_state", true);
    expect(modal.plague).toBe(false);
    expect(modal.protectedState).toBe(true);
    toggle(modal, "game_settings.horde_night", true);
    expect(modal.protectedState).toBe(false);
    toggle(modal, "game_settings.protected_state", true);
    expect(modal.hordeNight).toBe(false);
    modal.gameMode = GameMode.Team;
    modal.handleBossRaidSelected();
    expect(modal.protectedState).toBe(false);
  });

  it("old presets without the field load with it off", async () => {
    const { modal } = singlePlayer();
    modal.protectedState = true;
    await modal.importPresetConfig({
      ...modal.exportPresetConfig(),
      protectedState: undefined,
    });
    expect(modal.protectedState).toBe(false);
  });

  it("names the mode on its card and shows its rule while on", () => {
    const el = document.createElement("game-config-settings") as any;
    const host = document.createElement("div");
    const card = (checked: boolean) => ({
      labelKey: "game_settings.protected_state",
      checked,
      ruleKey: "protected_state.rules",
      textParams: { mode: PROTECTED_STATE_MODE_NAME },
    });
    render(el.renderOptionToggle(card(false)), host);
    expect(host.textContent).toContain(PROTECTED_STATE_MODE_NAME);
    expect(host.querySelector("[data-mode-rule]")).toBeNull();
    render(el.renderOptionToggle(card(true)), host);
    expect(host.querySelector("[data-mode-rule]")?.textContent).toContain(
      "protected_state.rules",
    );
  });
});
