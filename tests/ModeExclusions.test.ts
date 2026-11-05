import {
  GameMapType,
  GameMode,
  GameType,
} from "@openfront/engine-api/game/GameTypes";
import { ADMIN_BOT_CLIENT_ID } from "@openfront/engine-api/Schemas";
import {
  exclusiveModeError,
  exclusiveModesOn,
} from "@openfront/engine-lib/game/ModeExclusions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdminBotRoutes } from "../src/server/AdminBotRoutes";
import { previewGameConfigPatch } from "../src/server/ConfigPatch";
import { hostTeamPickingAllowed } from "../src/server/HostTeamPins";
import { ServerEnv } from "../src/server/ServerEnv";
import { makeGame } from "./util/GameServerHarness";
import { testGameConfig } from "./util/Wire";

const BOSS = { boss: "nation" };

describe("exclusive lobby modes", () => {
  it("lists Boss Raid (Team games only), Horde Night and the plague", () => {
    expect(exclusiveModesOn({})).toEqual([]);
    expect(
      exclusiveModesOn({ gameMode: GameMode.Team, bossRaid: BOSS }),
    ).toEqual(["bossRaid"]);
    // A Boss pick left over in an FFA lobby isn't a Boss Raid.
    expect(exclusiveModesOn({ gameMode: GameMode.FFA, bossRaid: BOSS })).toEqual(
      [],
    );
    expect(exclusiveModesOn({ hordeNight: { enabled: false } })).toEqual([]);
    expect(
      exclusiveModesOn({ hordeNight: { enabled: true }, plague: true }),
    ).toEqual(["hordeNight", "plague"]);
  });

  it("allows one at a time and names the two that clash", () => {
    expect(exclusiveModeError({ plague: true })).toBeNull();
    expect(
      exclusiveModeError({
        gameMode: GameMode.Team,
        bossRaid: BOSS,
        hordeNight: { enabled: true },
      }),
    ).toBe("Boss Raid and Horde Night can't be played together");
    expect(
      exclusiveModeError({
        gameMode: GameMode.Team,
        bossRaid: BOSS,
        plague: true,
      }),
    ).toBe("Boss Raid and the zombie plague can't be played together");
    expect(
      exclusiveModeError({ hordeNight: { enabled: true }, plague: true }),
    ).toBe("Horde Night and the zombie plague can't be played together");
  });

  it("previews a patch without changing the stored config", () => {
    const stored = testGameConfig({ gameMode: GameMode.Team });
    const preview = previewGameConfigPatch(stored, { plague: true });
    expect(preview.plague).toBe(true);
    expect(stored.plague).toBeUndefined();
  });

  it("turns host team picking off in Horde Night, which has one side", () => {
    const config = {
      gameType: GameType.Private,
      gameMode: GameMode.Team,
      playerTeams: 2,
    } as const;
    expect(hostTeamPickingAllowed(config)).toBe(true);
    expect(
      hostTeamPickingAllowed({ ...config, hordeNight: { enabled: true } }),
    ).toBe(false);
  });
});

describe("the server refuses exclusive modes together", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  const ADMIN_ACTOR = {
    clientID: ADMIN_BOT_CLIENT_ID,
    isLobbyCreator: false,
    isAdmin: true,
    isAdminBot: true,
  };

  it("in update_game_config, against what the lobby already has", () => {
    const game = makeGame({ config: { hordeNight: { enabled: true } } });
    const refused = game.handleIntent(
      { type: "update_game_config", config: { plague: true } } as any,
      ADMIN_ACTOR,
    );
    expect(refused.status).toBe(400);
    expect(refused.error).toContain("can't be played together");
    expect(game.gameInfo().gameConfig?.plague).toBeUndefined();

    // Switching one off and the other on in the same patch is fine.
    const ok = game.handleIntent(
      {
        type: "update_game_config",
        config: { hordeNight: { enabled: false }, plague: true },
      } as any,
      ADMIN_ACTOR,
    );
    expect(ok.status).toBe(200);
    expect(game.gameInfo().gameConfig?.plague).toBe(true);
  });

  it("in the admin bot's create_game", () => {
    vi.spyOn(ServerEnv, "generateGameIdForWorker").mockReturnValue("aaaaaaaa");
    vi.spyOn(ServerEnv, "workerPath").mockReturnValue("w0");
    const routes: Record<string, (req: any, res: any) => void> = {};
    const app: any = {
      post(path: string, ...handlers: ((req: any, res: any) => void)[]) {
        routes[path] = handlers[handlers.length - 1];
      },
      get() {},
    };
    const createGame = vi.fn(() => ({
      setListed: vi.fn(),
      gameInfo: () => ({ gameID: "x" }),
    }));
    const log: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    registerAdminBotRoutes({ app, gm: { createGame } as any, workerId: 0, log });
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };
    routes["/api/adminbot/create_game"](
      {
        body: {
          gameMap: GameMapType.World,
          gameMode: GameMode.Team,
          playerTeams: 2,
          bossRaid: BOSS,
          plague: true,
        },
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(createGame).not.toHaveBeenCalled();
  });
});
