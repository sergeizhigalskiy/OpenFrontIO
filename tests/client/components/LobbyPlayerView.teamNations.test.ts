import {
  ColoredTeams,
  Difficulty,
  GameMode,
} from "@openfront/engine-api/game/GameTypes";
import type { ClientInfo } from "@openfront/shared/WireSchemas";
import { beforeEach, describe, expect, it } from "vitest";
import "../../../src/client/components/LobbyPlayerView";
import type { LobbyTeamView } from "../../../src/client/components/LobbyPlayerView";
import { UserSettings } from "../../../src/client/UserSettings";

function client(
  clientID: string,
  overrides: Partial<ClientInfo> = {},
): ClientInfo {
  return { clientID, username: clientID, clanTag: null, ...overrides };
}

async function mount(
  props: Partial<LobbyTeamView> & { clients: ClientInfo[] },
): Promise<LobbyTeamView> {
  const view = document.createElement("lobby-player-view") as LobbyTeamView;
  view.gameMode = GameMode.Team;
  view.teamCount = 2;
  Object.assign(view, props);
  document.body.append(view);
  await view.updateComplete;
  return view;
}

const card = (view: LobbyTeamView, team: string) =>
  view.querySelector<HTMLElement>(`[data-team-drop="${team}"]`)!;

describe("lobby preview of each team's nations", () => {
  beforeEach(() => {
    localStorage.clear();
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    document.body.replaceChildren();
  });

  it("deals nations by points and flags stacked teams", async () => {
    // Both humans pinned to Red: Blue is short-handed.
    const view = await mount({
      teamPicking: true,
      nationCount: 10,
      difficulty: Difficulty.Hard,
      clients: [client("a", { teamIndex: 0 }), client("b", { teamIndex: 0 })],
    });
    const preview = (
      view as unknown as {
        nationPreview: {
          nations: Map<string, number>;
          stacked: string[];
        };
      }
    ).nationPreview;
    expect(preview.nations.get(ColoredTeams.Red)).toBe(2);
    expect(preview.nations.get(ColoredTeams.Blue)).toBe(8);
    expect(preview.stacked).toEqual([ColoredTeams.Blue]);

    expect(view.querySelector(".stacked-teams-note")).not.toBeNull();
    const red = card(view, "0").querySelector(".team-nations")!;
    const blue = card(view, "1").querySelector(".team-nations")!;
    expect(red.textContent).toContain("host_modal.team_nations");
    expect(red.className).not.toContain("amber");
    // The short-handed team's nations play a step harder.
    expect(blue.className).toContain("amber");
  });

  it("shows no stacked note when the humans are spread out", async () => {
    const view = await mount({
      nationCount: 6,
      difficulty: Difficulty.Hard,
      clients: [client("a"), client("b")],
    });
    expect(view.querySelector(".stacked-teams-note")).toBeNull();
    expect(card(view, "0").querySelector(".team-nations")).not.toBeNull();
    expect(card(view, "1").querySelector(".team-nations")).not.toBeNull();
  });

  it("marks stacked Impossible nations with their growth bonus", async () => {
    const view = await mount({
      teamPicking: true,
      nationCount: 4,
      difficulty: Difficulty.Impossible,
      clients: [client("a", { teamIndex: 0 }), client("b", { teamIndex: 0 })],
    });
    expect(
      card(view, "1").querySelector(".team-nations")!.textContent,
    ).toContain("host_modal.team_nations_growth");
  });
});
