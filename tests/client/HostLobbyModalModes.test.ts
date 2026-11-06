import { describe, expect, it, vi } from "vitest";

// The desktop bridge is absent in jsdom; mock it like HostLobbyModal.test.ts.
vi.mock("../../src/client/DesktopPresence", () => ({
  desktopPresence: {
    isAvailable: vi.fn(() => false),
    openInviteDialog: vi.fn(async () => true),
    set: vi.fn(),
    consumePendingInvite: vi.fn(async () => null),
    subscribeInvites: vi.fn(() => () => undefined),
  },
}));

import { HostLobbyModal } from "../../src/client/HostLobbyModal";

function modalWithStubbedPush() {
  const modal = new HostLobbyModal() as any;
  modal.putGameConfig = vi.fn(); // network push stubbed out
  return modal;
}

function toggle(modal: any, labelKey: string, checked: boolean): void {
  modal.handleConfigOptionToggleChanged(
    new CustomEvent("option-toggle-changed", {
      detail: { labelKey, checked },
    }),
  );
}

describe("HostLobbyModal game modes", () => {
  it("Horde Night turns donations on and takes the picked length", () => {
    const modal = modalWithStubbedPush();
    expect(modal.donateTroops).toBe(false);
    toggle(modal, "game_settings.horde_night", true);
    expect(modal.hordeNight).toBe(true);
    expect(modal.donateTroops).toBe(true);
    expect(modal.donateGold).toBe(true);
    modal.handleConfigOptionMinutesSelected(
      new CustomEvent("option-minutes-selected", {
        detail: { labelKey: "game_settings.horde_night", minutes: 15 },
      }),
    );
    expect(modal.hordeNightSurvivalMinutes).toBe(15);
    expect(modal.putGameConfig).toHaveBeenCalledTimes(2);
  });

  it("Horde Night and the plague are exclusive", () => {
    const modal = modalWithStubbedPush();
    toggle(modal, "game_settings.plague", true);
    toggle(modal, "game_settings.horde_night", true);
    expect(modal.plague).toBe(false);
    expect(modal.hordeNight).toBe(true);
  });

  it("keeps the Boss's timer between 15 and 60 minutes", () => {
    const modal = modalWithStubbedPush();
    const timer = (minutes: number) =>
      modal.handleBossRaidTimerChanged(
        new CustomEvent("boss-raid-timer-changed", { detail: { minutes } }),
      );
    timer(5);
    expect(modal.maxTimerValue).toBe(15);
    timer(90);
    expect(modal.maxTimerValue).toBe(60);
    timer(40);
    expect(modal.maxTimerValue).toBe(40);
  });
});
