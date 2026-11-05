vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
  renderDuration: vi.fn(() => ""),
}));

import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { describe, expect, it, vi } from "vitest";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import {
  CITY_STATE_FLAG,
  playerStaticFromUpdate,
} from "../../src/client/view/EntityState";
import { WebGLFrameBuilder } from "../../src/client/WebGLFrameBuilder";
import { makePlayerUpdate, makePlayerView } from "../util/viewStubs";

const BASE: GameConfig = {
  gameMap: GameMapType.World,
  gameMapSize: GameMapSize.Normal,
  gameMode: GameMode.FFA,
  gameType: GameType.Private,
  difficulty: Difficulty.Easy,
  nations: "default",
  donateGold: false,
  donateTroops: false,
  bots: 400,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  randomSpawn: false,
};

describe("world features in the client", () => {
  it("the lobby summary lists ruins and city-states only when turned off", () => {
    const labels = (c: GameConfig) =>
      notableLobbySettings(c, null).map((i) => `${i.label}=${i.value}`);
    expect(labels(BASE)).toEqual([]);
    expect(labels({ ...BASE, ruins: true, cityStates: true })).toEqual([]);
    expect(labels({ ...BASE, ruins: false, cityStates: false })).toEqual([
      "game_settings.ruins=common.disabled",
      "game_settings.city_states=common.disabled",
    ]);
  });

  it("a city-state is marked from its first update on", () => {
    const cityState = makePlayerUpdate({
      playerType: PlayerType.Bot,
      isCityState: true,
    });
    expect(playerStaticFromUpdate(cityState).isCityState).toBe(true);
    expect("isCityState" in playerStaticFromUpdate(makePlayerUpdate())).toBe(
      false,
    );
    expect(makePlayerView({ data: cityState }).isCityState()).toBe(true);
    expect(makePlayerView().isCityState()).toBe(false);
    expect(CITY_STATE_FLAG).toBe("/images/CityStateFlag.svg");
  });

  it("the renderer gets the ruins when the list changes, and only then", () => {
    const updateRuins = vi.fn();
    const builder = new WebGLFrameBuilder({ updateRuins } as never);
    let ruins: readonly number[] = [];
    const view = {
      ruins: () => ruins,
      x: (t: number) => t % 100,
      y: (t: number) => Math.floor(t / 100),
    };
    const sync = () =>
      (builder as unknown as { syncRuins(v: unknown): void }).syncRuins(view);

    sync();
    expect(updateRuins).toHaveBeenLastCalledWith([]);
    ruins = [205, 1010];
    sync();
    sync();
    expect(updateRuins).toHaveBeenCalledTimes(2);
    expect(updateRuins).toHaveBeenLastCalledWith([
      { x: 5, y: 2 },
      { x: 10, y: 10 },
    ]);
  });
});
