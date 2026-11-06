import {
  ColoredTeams,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import type { GameConfig } from "@openfront/engine-api/Schemas";
import {
  HORDE_DEFENDERS_TEAM,
  HORDE_TEAM,
} from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_PLAYER_ID,
  INFECTED_TEAM,
} from "@openfront/engine-lib/game/Plague";
import { colord } from "colord";
import { describe, expect, test, vi } from "vitest";
import { infectedPulseColor } from "../../src/client/render/frame/InfectedPulse";
import defaultTheme from "../../src/client/render/gl/default-theme.json";
import { createThemeSettings } from "../../src/client/render/gl/RenderSettings";
import { SettingsTheme } from "../../src/client/theme/ThemeProvider";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import type { GameView, PlayerView } from "../../src/client/view";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));

const { survivalModeEnding } =
  await import("../../src/client/hud/layers/SurvivalModeEnding");

const BASE: GameConfig = {
  gameMap: GameMapType.Asia,
  difficulty: Difficulty.Medium,
  donateGold: false,
  donateTroops: false,
  gameType: GameType.Private,
  gameMode: GameMode.FFA,
  gameMapSize: GameMapSize.Normal,
  nations: "default",
  bots: 0,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

function fakeGame(
  config: Partial<GameConfig>,
  me: { team: string | null; clientID: string } | null,
  infectedAlive: boolean | null = null,
  hordeOutcome: string | null = null,
): GameView {
  return {
    config: () => ({ gameConfig: () => ({ ...BASE, ...config }) }),
    cataclysm: () => ({
      horde:
        hordeOutcome === null
          ? null
          : { kind: "horde", startLand: [], outcome: hordeOutcome },
    }),
    myPlayer: () =>
      me === null ? null : { team: () => me.team, clientID: () => me.clientID },
    hasPlayer: (id: string) =>
      id === INFECTED_PLAYER_ID && infectedAlive !== null,
    player: () => ({ isAlive: () => infectedAlive === true }),
    playerByClientID: (id: string) => ({ displayName: () => `name_${id}` }),
  } as unknown as GameView;
}

describe("survival mode endings", () => {
  test("Horde Night names its win and its loss", () => {
    const horde = { hordeNight: { enabled: true } };
    const defender = { team: HORDE_DEFENDERS_TEAM, clientID: "c1" };
    expect(
      survivalModeEnding(fakeGame(horde, defender), [
        "team",
        HORDE_DEFENDERS_TEAM,
        "c1",
      ]),
    ).toEqual({ title: "horde_night.defenders_won", isWin: true });
    expect(
      survivalModeEnding(fakeGame(horde, defender), ["team", HORDE_TEAM]),
    ).toEqual({ title: "horde_night.horde_won", isWin: false });
    // A spectator sees the win but doesn't share it.
    expect(
      survivalModeEnding(fakeGame(horde, null), ["team", HORDE_DEFENDERS_TEAM])
        ?.isWin,
    ).toBe(false);
    // Held between 25% and 50% of the land at the timer: a narrow win.
    expect(
      survivalModeEnding(fakeGame(horde, defender, null, "narrow"), [
        "team",
        HORDE_DEFENDERS_TEAM,
        "c1",
      ]),
    ).toEqual({ title: "horde_night.narrow_win", isWin: true });
  });

  test("the plague: a consumed world, or the usual title (cured or not)", () => {
    const plague = { plague: true };
    const me = { team: null, clientID: "c1" };
    expect(
      survivalModeEnding(fakeGame(plague, me, true), ["team", INFECTED_TEAM]),
    ).toEqual({ title: "plague.consumed", isWin: false });
    // Killing The Infected ends nothing: the game is won the usual way.
    expect(
      survivalModeEnding(fakeGame(plague, me, false), ["player", "c1"]),
    ).toBeNull();
    expect(
      survivalModeEnding(fakeGame(plague, me, true), ["player", "c1"]),
    ).toBeNull();
  });

  test("neither mode on: the usual titles", () => {
    expect(
      survivalModeEnding(fakeGame({}, null), ["team", HORDE_TEAM]),
    ).toBeNull();
    expect(survivalModeEnding(fakeGame({}, null), undefined)).toBeNull();
  });
});

describe("survival mode lobby summary", () => {
  test("lists both when on and neither by default", () => {
    const labels = (c: Partial<GameConfig>) =>
      notableLobbySettings({ ...BASE, ...c }, null).map((i) => i.label);
    expect(labels({})).not.toContain("horde_night.title");
    expect(labels({})).not.toContain("game_settings.plague");
    const on = notableLobbySettings(
      {
        ...BASE,
        hordeNight: { enabled: true, survivalMinutes: 45 },
        plague: true,
      },
      null,
    );
    expect(on.map((i) => i.label)).toContain("horde_night.title");
    expect(on.map((i) => i.label)).toContain("game_settings.plague");
  });
});

describe("survival mode colors", () => {
  const view = (id: string, team: string | null, type: PlayerType) =>
    ({ id: () => id, team: () => team, type: () => type }) as PlayerView;

  test("bands in the flat horde color, The Infected in sickly green", () => {
    const theme = new SettingsTheme(createThemeSettings("default"));
    const horde = colord(defaultTheme.teamColors.Horde);
    expect(
      theme.territoryColor(view("b1", HORDE_TEAM, PlayerType.Bot)).toHex(),
    ).toBe(horde.toHex());
    expect(
      theme.territoryColor(view("b2", HORDE_TEAM, PlayerType.Bot)).toHex(),
    ).toBe(horde.toHex());
    for (const team of [null, ColoredTeams.Bot]) {
      expect(
        theme
          .territoryColor(view(INFECTED_PLAYER_ID, team, PlayerType.Bot))
          .toHex(),
      ).toBe(colord(defaultTheme.teamColors.Infected).toHex());
    }
  });

  test("defenders keep their own colors", () => {
    const theme = new SettingsTheme(createThemeSettings("default"));
    const a = theme.territoryColor(
      view("a", HORDE_DEFENDERS_TEAM, PlayerType.Human),
    );
    const b = theme.territoryColor(
      view("b", HORDE_DEFENDERS_TEAM, PlayerType.Human),
    );
    expect(a.isEqual(b)).toBe(false);
  });

  test("The Infected's land pulses", () => {
    const base = colord(defaultTheme.teamColors.Infected);
    const peak = infectedPulseColor(base, 600);
    const trough = infectedPulseColor(base, 1800);
    expect(peak.brightness()).toBeGreaterThan(base.brightness());
    expect(trough.brightness()).toBeLessThan(base.brightness());
  });
});
