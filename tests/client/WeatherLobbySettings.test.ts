import { WeatherKind } from "@openfront/engine-api/game/GameUpdates";
import { GameConfig, GameConfigSchema } from "@openfront/engine-api/Schemas";
import { weatherDrawCells } from "../../src/client/render/gl/passes/WeatherPass";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";

vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string) => key,
  renderDuration: () => "",
}));

const base: GameConfig = {
  gameMap: "World",
  gameMapSize: "Normal",
  gameMode: "Free For All",
  gameType: "Private",
  difficulty: "Easy",
  nations: "default",
  bots: 0,
  infiniteGold: false,
  donateGold: false,
  infiniteTroops: false,
  donateTroops: false,
  instantBuild: false,
  randomSpawn: false,
} as GameConfig;

describe("Seasons and Weather lobby settings", () => {
  it("are optional booleans in the game config", () => {
    expect(GameConfigSchema.parse(base).seasons).toBeUndefined();
    const off = GameConfigSchema.parse({
      ...base,
      seasons: false,
      weather: false,
    });
    expect(off.seasons).toBe(false);
    expect(off.weather).toBe(false);
    expect(() => GameConfigSchema.parse({ ...base, weather: "yes" })).toThrow();
  });

  it("show in the lobby summary only when turned off", () => {
    const labels = (c: GameConfig) =>
      notableLobbySettings(c, null).map((i) => `${i.label}=${i.value}`);
    expect(labels(base).join()).not.toMatch(/seasons|weather/);
    expect(
      labels({ ...base, seasons: true, weather: true }).join(),
    ).not.toMatch(/seasons|weather/);
    expect(labels({ ...base, seasons: false })).toContain(
      "game_settings.seasons=common.disabled",
    );
    expect(labels({ ...base, weather: false })).toContain(
      "game_settings.weather=common.disabled",
    );
  });
});

describe("weather overlay cells", () => {
  const cell = {
    id: 1,
    kind: WeatherKind.Storm,
    x: 10,
    y: 20,
    dx: 0.1,
    dy: 0,
    radius: 50,
    announceTick: 100,
    activeTick: 400,
    endTick: 1600,
  };

  it("draw a forecast outline, then a filled cell that drifts and fades", () => {
    expect(weatherDrawCells([cell], 99)).toEqual([]);
    const [forecast] = weatherDrawCells([cell], 200);
    expect(forecast).toMatchObject({ active: false, radius: 50, kind: 1 });
    expect(forecast.x).toBeCloseTo(20, 9);
    const [fading] = weatherDrawCells([cell], 410);
    expect(fading.active).toBe(true);
    expect(fading.fade).toBeCloseTo(0.5, 9);
    expect(weatherDrawCells([cell], 1000)[0].fade).toBe(1);
    expect(weatherDrawCells([cell], 1600)).toEqual([]);
  });
});
