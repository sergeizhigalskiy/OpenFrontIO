import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  humanTeams,
  resolveTeamsList,
} from "@openfront/engine-lib/game/TeamAssignment";
import { ClientAssignTeamMessageSchema } from "@openfront/shared/WireSchemas";
import { Client } from "../../src/server/Client";
import { GameServer } from "../../src/server/GameServer";
import { teamSlots } from "../../src/server/HostTeamPins";
import {
  cid,
  makeClient,
  makeGame,
  mockLogger,
  mockWsOf,
  startGame,
} from "../util/GameServerHarness";

const HOST_PID = "host-pid";

// A private Team lobby the host made, with nations off so the seat maths is
// only the players: `teams` teams of ceil(players / teams) seats.
function teamLobby(teams = 2): GameServer {
  return makeGame({
    log: mockLogger(),
    creatorPersistentID: HOST_PID,
    config: {
      gameType: GameType.Private,
      gameMode: GameMode.Team,
      playerTeams: teams,
      nations: "disabled",
    },
  });
}

function join(game: GameServer, tag: string, host = false): Client {
  const client = makeClient({
    clientID: cid(tag),
    persistentID: host ? HOST_PID : `${tag}-pid`,
    publicId: `${tag}-pub`,
  });
  expect(game.joinClient(client)).toBe("joined");
  return client;
}

function startInfo(game: GameServer, client: Client) {
  const start = mockWsOf(client)
    .sent()
    .find((m) => m.type === "start");
  if (start?.type !== "start") throw new Error("no start message");
  return start.gameStartInfo;
}

// The team the engine puts each human on, from the start message alone (the
// same inputs every client builds the game from).
function engineTeams(game: GameServer, client: Client, teams: number) {
  const info = startInfo(game, client);
  const humans = info.players.map(
    (p) =>
      new PlayerInfo(
        p.username,
        PlayerType.Human,
        p.clientID,
        p.clientID,
        p.isLobbyCreator ?? false,
        p.clanTag,
        p.friends ?? [],
        p.teamIndex ?? null,
      ),
  );
  const assigned = humanTeams(humans, teams, 0);
  const names = resolveTeamsList(teams, humans.length);
  return new Map(
    info.players.map((p, i) => [p.clientID, names.indexOf(assigned[i]!)]),
  );
}

describe("host team picking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("refuses moves from anyone but the host", async () => {
    const game = teamLobby();
    const host = join(game, "host", true);
    const p1 = join(game, "p1");
    join(game, "p2");
    expect(game.assignTeamPin(p1.clientID, cid("p2"), 0)).toBe(
      "team_pick.not_host",
    );
    // Over the socket the refusal goes back to the sender, and nothing moves.
    await mockWsOf(p1).emit({
      type: "assign_team",
      target: cid("p2"),
      teamIndex: 1,
    });
    expect(mockWsOf(p1).sent()).toContainEqual({
      type: "error",
      error: "team_pick.not_host",
    });
    const lobby = game.gameInfo(host.clientID);
    expect(lobby.clients?.every((c) => c.teamIndex === undefined)).toBe(true);
  });

  it("broadcasts a host's move to everyone in the lobby", async () => {
    const game = teamLobby();
    const host = join(game, "host", true);
    const p1 = join(game, "p1");
    await mockWsOf(host).emit({
      type: "assign_team",
      target: p1.clientID,
      teamIndex: 1,
    });
    const infos = mockWsOf(p1)
      .sent()
      .filter((m) => m.type === "lobby_info");
    const last = infos[infos.length - 1];
    if (last?.type !== "lobby_info") throw new Error("no lobby_info");
    const entry = last.lobby.clients?.find((c) => c.clientID === p1.clientID);
    expect(entry?.teamIndex).toBe(1);
    // And back to auto.
    expect(game.assignTeamPin(host.clientID, p1.clientID, null)).toBeNull();
    const after = game.gameInfo(p1.clientID);
    expect(
      after.clients?.find((c) => c.clientID === p1.clientID)?.teamIndex,
    ).toBeUndefined();
  });

  it("refuses a move that would overflow a team", () => {
    const game = teamLobby(2);
    const host = join(game, "host", true);
    join(game, "p1");
    join(game, "p2");
    join(game, "p3");
    // Four players, two teams: two seats each.
    expect(game.assignTeamPin(host.clientID, cid("p1"), 0)).toBeNull();
    expect(game.assignTeamPin(host.clientID, cid("p2"), 0)).toBeNull();
    expect(game.assignTeamPin(host.clientID, cid("p3"), 0)).toBe(
      "team_pick.team_full",
    );
    // Moving someone already on the team is not an overflow.
    expect(game.assignTeamPin(host.clientID, cid("p2"), 0)).toBeNull();
    expect(game.assignTeamPin(host.clientID, cid("p3"), 2)).toBe(
      "team_pick.no_such_team",
    );
    expect(game.assignTeamPin(host.clientID, cid("zz"), 1)).toBe(
      "team_pick.unknown_player",
    );
  });

  it("is only offered in host-made Team lobbies", () => {
    const ffa = makeGame({
      creatorPersistentID: HOST_PID,
      config: { gameType: GameType.Private, gameMode: GameMode.FFA },
    });
    const host = join(ffa, "host", true);
    join(ffa, "p1");
    expect(ffa.assignTeamPin(host.clientID, cid("p1"), 0)).toBe(
      "team_pick.not_allowed",
    );
    expect(
      teamSlots({
        config: {
          gameType: GameType.Private,
          gameMode: GameMode.Team,
          playerTeams: 2,
          bossRaid: { boss: "nation" },
        },
        players: [cid("host"), cid("p1")],
        nationCount: 2,
      }),
    ).toBeNull();
  });

  it("refuses moves once the game has started", () => {
    const game = teamLobby();
    const host = join(game, "host", true);
    join(game, "p1");
    startGame(game);
    expect(game.assignTeamPin(host.clientID, cid("p1"), 0)).toBe(
      "team_pick.started",
    );
  });

  it("keeps the host's pins in the started game, and balances the rest", () => {
    const game = teamLobby(3);
    const host = join(game, "host", true);
    for (const tag of ["p1", "p2", "p3", "p4", "p5"]) join(game, tag);
    // Six players, three teams of two. Pin p1 and p2 together on team 2 and
    // the host on team 0; the other three are left to auto balancing.
    expect(game.assignTeamPin(host.clientID, cid("p1"), 2)).toBeNull();
    expect(game.assignTeamPin(host.clientID, cid("p2"), 2)).toBeNull();
    expect(game.assignTeamPin(host.clientID, host.clientID, 0)).toBeNull();
    startGame(game);

    const info = startInfo(game, host);
    const pinned = new Map(info.players.map((p) => [p.clientID, p.teamIndex]));
    expect(pinned.get(cid("p1"))).toBe(2);
    expect(pinned.get(cid("p2"))).toBe(2);
    expect(pinned.get(host.clientID)).toBe(0);
    expect(pinned.get(cid("p3"))).toBeUndefined();

    const teams = engineTeams(game, host, 3);
    expect(teams.get(cid("p1"))).toBe(2);
    expect(teams.get(cid("p2"))).toBe(2);
    expect(teams.get(host.clientID)).toBe(0);
    // The unpinned three fill the open seats: one beside the host, two on
    // team 1, none on the full team 2.
    const sizes = [0, 0, 0];
    for (const t of teams.values()) sizes[t]++;
    expect(sizes).toEqual([2, 2, 2]);
    for (const tag of ["p3", "p4", "p5"]) {
      expect(teams.get(cid(tag))).not.toBe(2);
    }
  });

  it("drops a pin when its player leaves, so the start info stays valid", () => {
    const game = teamLobby(2);
    const host = join(game, "host", true);
    const p1 = join(game, "p1");
    expect(game.assignTeamPin(host.clientID, p1.clientID, 1)).toBeNull();
    p1.spectator = true;
    expect(
      game
        .gameInfo(host.clientID)
        .clients?.find((c) => c.clientID === p1.clientID)?.teamIndex,
    ).toBeUndefined();
  });
});

describe("assign_team wire schema", () => {
  it("takes a clientID and a team slot or null", () => {
    expect(
      ClientAssignTeamMessageSchema.safeParse({
        type: "assign_team",
        target: "aB3dEf7h",
        teamIndex: 3,
      }).success,
    ).toBe(true);
    expect(
      ClientAssignTeamMessageSchema.safeParse({
        type: "assign_team",
        target: "aB3dEf7h",
        teamIndex: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    { target: "bad", teamIndex: 0 },
    { target: "aB3dEf7h", teamIndex: -1 },
    { target: "aB3dEf7h", teamIndex: 1.5 },
    { target: "aB3dEf7h" },
  ])("rejects %o", (fields) => {
    expect(
      ClientAssignTeamMessageSchema.safeParse({
        type: "assign_team",
        ...fields,
      }).success,
    ).toBe(false);
  });
});
