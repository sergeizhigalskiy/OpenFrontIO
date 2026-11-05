import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfigSchema } from "@openfront/engine-api/Schemas";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { HordeNightExecution } from "@openfront/engine/execution/HordeNightExecution";
import { PlagueExecution } from "@openfront/engine/execution/PlagueExecution";
import { Game } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import { setup } from "../util/Setup";

// Horde Night and the plague are lobby options, both off unless set.
async function runnerExecutions(config: Record<string, unknown>) {
  const game: Game = await setup("plains", config, [
    new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
  ]);
  new GameRunner(
    game,
    new Executor(game, "survival", undefined),
    () => {},
  ).init();
  // Executions added before the first tick wait to be initialized.
  game.executeNextTick();
  return game.executions();
}

describe("survival lobby modes", () => {
  test("both are off by default", async () => {
    const game = await setup("plains", {});
    expect(game.config().hordeNightConfig().enabled).toBe(false);
    expect(game.config().plague()).toBe(false);
    const execs = await runnerExecutions({});
    expect(execs.some((e) => e instanceof HordeNightExecution)).toBe(false);
    expect(execs.some((e) => e instanceof PlagueExecution)).toBe(false);
  });

  test("the game runner starts each when the lobby turns it on", async () => {
    const horde = await runnerExecutions({ hordeNight: { enabled: true } });
    expect(horde.some((e) => e instanceof HordeNightExecution)).toBe(true);
    expect(horde.some((e) => e instanceof PlagueExecution)).toBe(false);
    const plague = await runnerExecutions({ plague: true });
    expect(plague.some((e) => e instanceof PlagueExecution)).toBe(true);
    expect(plague.some((e) => e instanceof HordeNightExecution)).toBe(false);
  });

  test("the config schema takes both and bounds the survival timer", () => {
    const base = {
      gameMap: GameMapType.Asia,
      difficulty: Difficulty.Medium,
      donateGold: false,
      donateTroops: false,
      gameType: GameType.Singleplayer,
      gameMode: GameMode.FFA,
      gameMapSize: GameMapSize.Normal,
      nations: "default",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    };
    const parsed = GameConfigSchema.safeParse({
      ...base,
      hordeNight: { enabled: true, survivalMinutes: 45 },
      plague: true,
    });
    expect(parsed.success).toBe(true);
    expect(
      GameConfigSchema.safeParse({
        ...base,
        hordeNight: { enabled: true, survivalMinutes: 0 },
      }).success,
    ).toBe(false);
    expect(
      GameConfigSchema.safeParse({
        ...base,
        hordeNight: { enabled: true, survivalMinutes: 121 },
      }).success,
    ).toBe(false);
  });
});
