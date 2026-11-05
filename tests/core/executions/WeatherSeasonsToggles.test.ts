import {
  GameMapSize,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import { SEASON_CYCLE_TICKS } from "@openfront/engine-lib/game/Seasons";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { WeatherExecution } from "@openfront/engine/execution/WeatherExecution";
import { describe, expect, it, vi } from "vitest";
import { conquerRect } from "../../util/ConventionalWar";
import {
  createScriptedRunner,
  scriptedGameStart,
  stepScripted,
} from "../../util/ScriptedGame";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

const IN_WINTER = SEASON_CYCLE_TICKS + 100;
const FAIR = SEASON_CYCLE_TICKS - 1000;

describe("the Seasons lobby setting", () => {
  it("is on by default and off when the config says so", async () => {
    expect((await setup("plains")).config().seasonsEnabled()).toBe(true);
    const off = await setup("plains", { seasons: false });
    expect(off.config().seasonsEnabled()).toBe(false);
    expect(off.config().isWinter(IN_WINTER)).toBe(false);
  });

  /** a's losses attacking b in the snow, and a's troop growth, at `clock`. */
  async function winterEffects(config: Partial<GameConfig>, clock: number) {
    const game = await setup(
      "plains",
      config,
      [
        new PlayerInfo("a", PlayerType.Human, null, "a"),
        new PlayerInfo("b", PlayerType.Human, null, "b"),
      ],
      undefined,
      UseRealAttackLogic,
    );
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(clock);
    const a = game.player("a");
    const b = game.player("b");
    conquerRect(game, a, 0, 0, 50, 20);
    conquerRect(game, b, 50, 0, 100, 20);
    a.setTroops(200_000);
    b.setTroops(1_000);
    const growth = game.config().troopIncreaseRate(b, game.ticksSinceStart());
    game.addExecution(new AttackExecution(100_000, a, b.id()));
    executeTicks(game, 6);
    return { lost: 100_000 - a.outgoingAttacks()[0].troops(), growth };
  }

  it("when off, winter changes neither attack losses nor troop growth", async () => {
    const fair = await winterEffects({}, FAIR);
    const winterOn = await winterEffects({}, IN_WINTER);
    const winterOff = await winterEffects({ seasons: false }, IN_WINTER);
    expect(winterOn.lost).toBeGreaterThan(fair.lost);
    expect(winterOn.growth).toBeLessThan(fair.growth);
    expect(winterOff).toEqual(fair);
  });
});

describe("the Weather lobby setting", () => {
  // A small, quick game on the plains map: no nations, no tribes.
  const start = (config: Partial<GameConfig>) =>
    scriptedGameStart({
      gameMapSize: GameMapSize.Normal,
      nations: "disabled",
      bots: 0,
      doomsdayClock: undefined,
      ...config,
    });

  it("is on by default: the game runs a WeatherExecution after the spawn phase", async () => {
    const runner = await createScriptedRunner("plains", start({}));
    const game = runner.game;
    expect(game.config().weatherEnabled()).toBe(true);
    expect(
      game.executions().filter((e) => e instanceof WeatherExecution),
    ).toHaveLength(1);
    expect(game.weather()).toBeNull();
    while (game.inSpawnPhase()) stepScripted(runner);
    stepScripted(runner);
    stepScripted(runner);
    expect(game.weather()).not.toBeNull();
    expect(game.weather()!.cells().length).toBeGreaterThanOrEqual(1);
  });

  it("when off, no weather runs at all", async () => {
    const runner = await createScriptedRunner(
      "plains",
      start({ weather: false }),
    );
    const game = runner.game;
    expect(game.config().weatherEnabled()).toBe(false);
    expect(game.executions().some((e) => e instanceof WeatherExecution)).toBe(
      false,
    );
    while (game.inSpawnPhase()) stepScripted(runner);
    for (let i = 0; i < 20; i++) stepScripted(runner);
    expect(game.weather()).toBeNull();
  });
});
