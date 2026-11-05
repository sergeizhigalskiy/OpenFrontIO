import { GameMode } from "@openfront/engine-api/game/GameTypes";
import type { ClientInfo } from "@openfront/shared/WireSchemas";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const chip = (view: LobbyTeamView, id: string, within: Element = view) =>
  within.querySelector<HTMLElement>(`[data-chip="${id}"]`);
const drop = (view: LobbyTeamView, team: string) =>
  view.querySelector<HTMLElement>(`[data-team-drop="${team}"]`)!;

describe("lobby team picking", () => {
  beforeEach(() => {
    localStorage.clear();
    (
      UserSettings as unknown as { cache: Map<string, string | null> }
    ).cache.clear();
    document.body.replaceChildren();
  });

  it("lists the unpinned players in the auto bucket, pinned ones on their team", async () => {
    const view = await mount({
      teamPicking: true,
      clients: [client("host"), client("a", { teamIndex: 1 }), client("b")],
    });
    const bucket = drop(view, "auto");
    expect(bucket.textContent).toContain("host_modal.team_pick_auto_bucket");
    expect(chip(view, "a", bucket)).toBeNull();
    expect(chip(view, "b", bucket)).not.toBeNull();
    const blue = drop(view, "1");
    expect(chip(view, "a", blue)?.textContent).toContain(
      "host_modal.team_pick_pinned",
    );
  });

  it("lets the host tap a player and then a team to move them", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount({
      teamPicking: true,
      onAssignTeam,
      clients: [client("host"), client("a"), client("b")],
    });
    chip(view, "a", drop(view, "auto"))!.click();
    await view.updateComplete;
    drop(view, "1").click();
    expect(onAssignTeam).toHaveBeenCalledWith("a", 1);
  });

  it("lets the host drag a player back to auto", async () => {
    const onAssignTeam = vi.fn();
    const view = await mount({
      teamPicking: true,
      onAssignTeam,
      clients: [client("host"), client("a", { teamIndex: 0 })],
    });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      dropEffect: "",
      effectAllowed: "",
    };
    const start = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
    chip(view, "a", drop(view, "0"))!.dispatchEvent(start);
    const end = new Event("drop", { bubbles: true }) as DragEvent;
    Object.defineProperty(end, "dataTransfer", { value: dataTransfer });
    drop(view, "auto").dispatchEvent(end);
    expect(onAssignTeam).toHaveBeenCalledWith("a", null);
  });

  it("refuses a move onto a full team with a message, sending nothing", async () => {
    const onAssignTeam = vi.fn();
    // Four players, two teams: two seats each, both of Red's taken.
    const view = await mount({
      teamPicking: true,
      onAssignTeam,
      clients: [
        client("host", { teamIndex: 0 }),
        client("a", { teamIndex: 0 }),
        client("b"),
        client("c"),
      ],
    });
    view.assignTeam("b", 0);
    await view.updateComplete;
    expect(onAssignTeam).not.toHaveBeenCalled();
    expect(view.querySelector(".team-pick-error")?.textContent).toContain(
      "team_pick.team_full_named",
    );
    view.assignTeam("b", 1);
    expect(onAssignTeam).toHaveBeenCalledWith("b", 1);
  });

  it("shows a non-host the picks but moves nobody", async () => {
    const view = await mount({
      teamPicking: true,
      clients: [client("host"), client("a", { teamIndex: 1 })],
    });
    const a = chip(view, "a", drop(view, "1"))!;
    expect(a.getAttribute("draggable")).toBe("false");
    a.click();
    await view.updateComplete;
    // Nothing picked up: no team lights up as a drop target.
    expect(drop(view, "0").className).not.toContain("cursor-pointer");
    expect(drop(view, "auto").textContent).toContain(
      "host_modal.team_pick_viewer_hint",
    );
  });

  it("previews a Boss Raid as the Boss against everyone else", async () => {
    const view = await mount({
      nationCount: 3,
      bossRaid: { boss: "b" },
      clients: [client("host"), client("a"), client("b")],
    });
    const boss = drop(view, "0");
    const raiders = drop(view, "1");
    expect(boss.textContent).toContain("Boss");
    expect(chip(view, "b", boss)).not.toBeNull();
    expect(chip(view, "a", raiders)).not.toBeNull();
    expect(chip(view, "host", raiders)).not.toBeNull();
    // 2 humans and 3 nations raid.
    expect(raiders.textContent).toContain("5/5");

    view.bossRaid = { boss: "nation" };
    await view.updateComplete;
    expect(
      drop(view, "0").querySelector(".boss-raid-nation-boss"),
    ).not.toBeNull();
    // 3 humans and 2 nations raid: the third nation is the Boss.
    expect(drop(view, "1").textContent).toContain("5/5");
  });
});
