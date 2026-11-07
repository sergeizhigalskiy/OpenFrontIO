import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getNews,
  getStreams,
  getUserMe,
  invalidateUserMe,
} from "../../src/client/Api";
import { AccountApiDisabledError, getApiBase } from "../../src/client/ApiBase";
import {
  getAuthHeader,
  getPlayToken,
  logOut,
  userAuth,
} from "../../src/client/Auth";
import { fetchClanExists } from "../../src/client/ClanApi";
import { ClientEnv } from "../../src/client/ClientEnv";
import { fetchCosmetics } from "../../src/client/Cosmetics";
import { fetchFriendRequests } from "../../src/client/FriendsApi";
import { fetchProgressionConfig } from "../../src/client/ProgressionApi";
import { fetchReplayRecord } from "../../src/client/replay/ReplayRecord";
import { listSavedGames } from "../../src/client/SavedGamesApi";
import {
  backendUnreachableConfirmed,
  ensureServerList,
  resetServerList,
  retryServerList,
  startServerListPolling,
} from "../../src/client/ServerList";
import { isStandalone } from "../../src/client/Standalone";
import { canHandOffToSteam } from "../../src/client/SteamHandoff";
import { findVersionedShell } from "../../src/client/VersionedReplay";

// STANDALONE=true: a private copy of the game with no account backend. The
// page must make no request to the account API (api.<audience>, or
// localhost:8787 in dev) and answer every account question the way it does
// for a signed-out player whose API is down, without the request.

const PERSISTENT_ID_KEY = "player_persistent_id";

// A deployed page, so nothing here passes merely because the audience is
// "localhost" or the env is dev.
function setBootstrap(overrides: Record<string, unknown> = {}) {
  window.BOOTSTRAP_CONFIG = {
    gameEnv: "prod",
    cluster: { a: { host: "friends.example.com", numWorkers: 2 } },
    instanceLetter: "a",
    turnstileSiteKey: "",
    jwtAudience: "example.com",
    instanceId: "test",
    gitCommit: "abc",
    faroCollectorUrl: "https://faro.example/collect",
    stripePublishableKey: "pk_test_abc",
    standalone: true,
    ...overrides,
  };
  ClientEnv.reset();
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setBootstrap();
  resetServerList();
  invalidateUserMe();
  fetchMock = vi.fn(async () => {
    throw new Error("standalone page made a request");
  });
  vi.stubGlobal("fetch", fetchMock);
  localStorage.setItem(PERSISTENT_ID_KEY, "persistent-id");
});

afterEach(() => {
  resetServerList();
  invalidateUserMe();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.BOOTSTRAP_CONFIG = undefined;
  ClientEnv.reset();
});

describe("the standalone flag", () => {
  it("is false when the page does not carry it", () => {
    setBootstrap({ standalone: undefined });
    expect(ClientEnv.standalone()).toBe(false);
    expect(isStandalone()).toBe(false);
  });

  it("is read from BOOTSTRAP_CONFIG", () => {
    expect(ClientEnv.standalone()).toBe(true);
    expect(isStandalone()).toBe(true);
  });

  it("reads as false, rather than throwing, with no BOOTSTRAP_CONFIG", () => {
    window.BOOTSTRAP_CONFIG = undefined;
    ClientEnv.reset();
    expect(isStandalone()).toBe(false);
  });

  it("drops the telemetry collector and the Stripe key whatever the page says", () => {
    expect(ClientEnv.faroCollectorUrl()).toBeUndefined();
    expect(ClientEnv.stripePublishableKey()).toBeUndefined();

    setBootstrap({ standalone: undefined });
    expect(ClientEnv.faroCollectorUrl()).toBe("https://faro.example/collect");
    expect(ClientEnv.stripePublishableKey()).toBe("pk_test_abc");
  });
});

describe("the account API address", () => {
  it("is refused rather than handed out", () => {
    expect(() => getApiBase()).toThrow(AccountApiDisabledError);
    expect(() => ClientEnv.jwtIssuer()).toThrow();
  });

  it("is handed out as before on a page that is not standalone", () => {
    setBootstrap({ standalone: undefined });
    expect(getApiBase()).toBe("https://api.example.com");
    expect(ClientEnv.jwtIssuer()).toBe("https://api.example.com");
  });
});

describe("auth on a standalone page", () => {
  it("resolves getUserMe as signed out without fetching", async () => {
    expect(await getUserMe()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never refreshes a JWT and plays under the persistent ID", async () => {
    expect(await userAuth()).toBe(false);
    expect(await getAuthHeader()).toBe("");
    expect(await getPlayToken()).toBe("persistent-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the persistent ID through a logOut, which has nothing to end", async () => {
    expect(await logOut()).toBe(false);
    expect(localStorage.getItem(PERSISTENT_ID_KEY)).toBe("persistent-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("account API callers on a standalone page", () => {
  it("use the bundled fallbacks for news and streams", async () => {
    expect((await getNews()).length).toBeGreaterThan(0);
    const streams = await getStreams();
    expect(streams.featured).toEqual([]);
    expect(streams.live).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answer with defaults and no request", async () => {
    expect(await fetchCosmetics()).toBeNull();
    expect(await fetchProgressionConfig()).toBe(false);
    expect(await fetchClanExists("ABC")).toBeNull();
    expect(await fetchFriendRequests()).toBe(false);
    expect(await listSavedGames()).toBe(false);
    expect(await fetchReplayRecord("aAbCd12345")).toEqual({
      kind: "not_found",
    });
    expect(
      await findVersionedShell(
        "example.com",
        "aAbCd12345",
        "friends.example.com",
        fetchMock as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never offers to hand a lobby link to the Steam build", () => {
    expect(canHandOffToSteam()).toBe(false);
  });
});

describe("the server list on a standalone page", () => {
  it("never starts polling", async () => {
    vi.useFakeTimers();
    startServerListPolling();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the page's own server without asking, and is never an outage", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      expect(await ensureServerList()).toBe("fallback");
      expect(await retryServerList()).toBe("fallback");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(backendUnreachableConfirmed()).toBe(false);
  });
});
