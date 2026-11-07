import { GameType } from "@openfront/engine-api/game/GameTypes";
import { GameEnv } from "@openfront/shared/configuration/Env";
import { GameRecord } from "@openfront/shared/WireSchemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/server/MapLandTiles", () => ({
  getMapLandTiles: async () => 1_000_000,
}));

vi.mock("../../src/server/Logger", () => ({
  logger: {
    child: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    }),
  },
}));

import { archive } from "../../src/server/Archive";
import { checkinBody } from "../../src/server/ClusterCheckin";
import { fetchCustomTribes } from "../../src/server/CustomTribes";
import { registerGamePreviewRoute } from "../../src/server/GamePreviewRoute";
import * as jwtModule from "../../src/server/jwt";
import { verifyClientToken } from "../../src/server/jwt";
import { MapPlaylist } from "../../src/server/MapPlaylist";
import { ServerEnv } from "../../src/server/ServerEnv";
import {
  joinVerifyEnabled,
  lobbyQueuePayment,
  registerListingRoute,
} from "../../src/server/Worker";
import { makeGame } from "../util/GameServerHarness";

// STANDALONE=true: the server runs with no account backend and never
// contacts one, whatever GAME_ENV says. Every test here runs as GAME_ENV=prod
// (the test process itself is dev, so env() is spied), which is where the
// account checks used to be unconditional.

const PERSISTENT_ID = "11111111-1111-4111-8111-111111111111";
// Shaped like a JWT, so it reaches the verification branch.
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln";

let fetchMock: ReturnType<typeof vi.fn>;

function asProd() {
  vi.spyOn(ServerEnv, "env").mockReturnValue(GameEnv.Prod);
}

beforeEach(() => {
  vi.stubEnv("DOMAIN", "example.com");
  vi.stubEnv("STANDALONE", "true");
  asProd();
  fetchMock = vi.fn(async () => {
    throw new Error("standalone server made a request");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the switch", () => {
  it("is on only for STANDALONE=true", () => {
    expect(ServerEnv.standalone()).toBe(true);
    vi.stubEnv("STANDALONE", "1");
    expect(ServerEnv.standalone()).toBe(false);
    vi.stubEnv("STANDALONE", "");
    expect(ServerEnv.standalone()).toBe(false);
  });

  it("turns the account checks off in prod, as dev already does", () => {
    expect(ServerEnv.accountsOff()).toBe(true);
    vi.stubEnv("STANDALONE", "");
    expect(ServerEnv.accountsOff()).toBe(false);
    vi.spyOn(ServerEnv, "env").mockReturnValue(GameEnv.Dev);
    expect(ServerEnv.accountsOff()).toBe(true);
  });
});

describe("tokens with GAME_ENV=prod", () => {
  it("accepts a bare persistent ID in standalone, without a JWKS fetch", async () => {
    expect(await verifyClientToken(PERSISTENT_ID)).toEqual({
      type: "success",
      persistentId: PERSISTENT_ID,
      claims: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses a bare persistent ID when not standalone", async () => {
    vi.stubEnv("STANDALONE", "");
    expect((await verifyClientToken(PERSISTENT_ID)).type).toBe("error");
  });

  it("refuses a JWT in standalone, since no issuer exists to check it", async () => {
    expect((await verifyClientToken(JWT)).type).toBe("error");
    await expect(ServerEnv.jwkPublicKey()).rejects.toThrow(/standalone/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("join verification and Turnstile with GAME_ENV=prod", () => {
  it("is skipped in standalone", () => {
    expect(joinVerifyEnabled()).toBe(false);
  });

  it("still runs when not standalone", () => {
    vi.stubEnv("STANDALONE", "");
    expect(joinVerifyEnabled()).toBe(true);
  });

  it("needs no Turnstile site key in standalone", () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    expect(ServerEnv.turnstileSiteKey()).toBe("");
    vi.stubEnv("STANDALONE", "");
    expect(() => ServerEnv.turnstileSiteKey()).toThrow(/TURNSTILE_SITE_KEY/);
  });
});

describe("lobby listing and queueing with GAME_ENV=prod", () => {
  it("charges nothing for the queue in standalone", async () => {
    expect(await lobbyQueuePayment("token", "abcd1234")()).toEqual({
      type: "success",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the API for the charge when not standalone", async () => {
    vi.stubEnv("STANDALONE", "");
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await lobbyQueuePayment("token", "abcd1234")()).toEqual({
      type: "success",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lists a lobby without the subscription check in standalone", async () => {
    let handler!: (req: any, res: any) => Promise<unknown>;
    const app = {
      post(path: string, h: typeof handler) {
        if (path === "/api/game/:id/listing") handler = h;
      },
    };
    const game = makeGame({
      creatorPersistentID: PERSISTENT_ID,
      config: { gameType: GameType.Private },
    });
    registerListingRoute({
      app: app as any,
      gm: { game: () => game } as any,
      lobbyService: {
        creatorHasListedLobby: () => false,
        hostedLobbyCount: () => 0,
      } as any,
      log: { info: vi.fn(), warn: vi.fn() } as any,
    });
    const getUserMe = vi.spyOn(jwtModule, "getUserMe");
    const res: any = {
      statusCode: 200,
      body: undefined,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: unknown) {
        this.body = data;
        return this;
      },
    };

    await handler(
      {
        headers: { authorization: `Bearer ${PERSISTENT_ID}` },
        params: { id: game.id },
        body: { listed: true },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ listed: true });
    expect(game.isListed()).toBe(true);
    expect(getUserMe).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("public lobbies in standalone", () => {
  // Trust is an account property only the API reports, so a trusted-only
  // lobby would be one nobody on this server could join.
  it("are never trusted-only", async () => {
    const playlist = new MapPlaylist();
    const types = ["ffa", "team", "special"] as const;
    for (let i = 0; i < 14; i++) {
      const config = await playlist.gameConfig(types[i % 3]);
      expect(config.trusted, `game ${i + 1}`).toBeUndefined();
    }
  });
});

describe("outbound API calls in standalone", () => {
  it("archives nothing", async () => {
    await archive({ info: { gameID: "abcd1234" } } as unknown as GameRecord);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws no purchased tribe names", async () => {
    expect(
      await fetchCustomTribes([{ clientId: "abcd1234", publicId: "p" }]),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Null is what keeps the master's check-in loop, its map-weights poll and
  // the lobby coordinator off.
  it("registers nowhere, even with a public host", () => {
    vi.stubEnv("SUBDOMAIN", "friends");
    vi.stubEnv("INSTANCE_LETTER", "a");
    vi.stubEnv("NUM_WORKERS", "2");
    expect(checkinBody(0)).toBeNull();
    vi.stubEnv("STANDALONE", "");
    expect(checkinBody(0)?.host).toBe("friends.example.com");
  });

  it("previews only live lobbies, without asking the archive", async () => {
    let handler!: (req: any, res: any) => Promise<unknown>;
    const app = {
      get(path: string, h: typeof handler) {
        if (path === "/game/:id") handler = h;
      },
    };
    registerGamePreviewRoute({
      app: app as any,
      gm: { game: () => null } as any,
      workerId: 0,
      log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as any,
      baseDir: __dirname,
    });
    const redirect = vi.fn();
    await handler(
      { params: { id: "abcd1234" }, headers: {}, get: () => undefined },
      { redirect, status: () => ({ json: vi.fn() }) },
    );
    expect(redirect).toHaveBeenCalledWith(302, "/");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the page no telemetry collector or Stripe key", () => {
    vi.stubEnv("FARO_COLLECTOR_URL", "https://faro.example/collect");
    vi.stubEnv("STRIPE_PUBLISHABLE_KEY", "pk_test_abc");
    expect(ServerEnv.faroCollectorUrl()).toBeUndefined();
    expect(ServerEnv.stripePublishableKey()).toBeUndefined();
    vi.stubEnv("STANDALONE", "");
    expect(ServerEnv.faroCollectorUrl()).toBe("https://faro.example/collect");
    expect(ServerEnv.stripePublishableKey()).toBe("pk_test_abc");
  });
});
