import type { ConvoyRouteForecast } from "@openfront/engine-api/game/ConvoyForecast";
import {
  CONVOY_SHELL_STEP,
  convoyLossAlong,
} from "@openfront/engine-lib/game/Convoys";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/client/hud/layers/SendResourceModal";
import type { SendResourceModal } from "../../src/client/hud/layers/SendResourceModal";

// Show each string's key with its parameters, so the numbers can be read.
vi.mock("../../src/client/Utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client/Utils")>()),
  translateText: (key: string, params?: Record<string, unknown>) =>
    params === undefined ? key : `${key} ${JSON.stringify(params)}`,
}));

function player(id: string, troops: number) {
  return {
    id: () => id,
    name: () => id,
    displayName: () => id,
    troops: () => troops,
    gold: () => 0n,
    isAlive: () => true,
  };
}

async function mount(routes: ConvoyRouteForecast[]) {
  const forecast = vi.fn().mockResolvedValue(routes);
  const players = new Map([["enemy", player("Enemy", 10)]]);
  const gameView = {
    worker: { convoyForecast: forecast },
    config: () => ({ maxTroops: () => 1_000_000 }),
    hasPlayer: (id: string) => players.has(id),
    player: (id: string) => players.get(id),
  };
  const modal = document.createElement(
    "send-resource-modal",
  ) as SendResourceModal;
  Object.assign(modal, {
    mode: "troops",
    total: 100_000,
    uiState: { attackRatio: 0.2 },
    myPlayer: player("me", 100_000),
    target: player("ally", 0),
    gameView,
    format: (n: number) => String(n),
  });
  document.body.append(modal);
  modal.open = true;
  await modal.updateComplete;
  await Promise.resolve();
  await modal.updateComplete;
  return { modal, forecast };
}

describe("donate panel convoy forecast", () => {
  beforeEach(() => document.body.replaceChildren());

  it("asks the engine for the routes and shows the one the convoy will take", async () => {
    const land: ConvoyRouteForecast = {
      mode: "land",
      length: 120,
      hostileTiles: 20,
      shells: 1,
      steps: [...new Array(20).fill(100), CONVOY_SHELL_STEP],
      crossed: ["enemy"],
    };
    const sea: ConvoyRouteForecast = {
      mode: "sea",
      length: 300,
      hostileTiles: 0,
      shells: 3,
      steps: [CONVOY_SHELL_STEP, CONVOY_SHELL_STEP, CONVOY_SHELL_STEP],
      crossed: [],
    };
    const { modal, forecast } = await mount([land, sea]);
    expect(forecast).toHaveBeenCalledWith("me", "ally");
    const text = modal.querySelector(".convoy-forecast")!.textContent!;
    // 20% of 100k: the land route loses fewer of 20k than three shells.
    const sent = 20_000;
    const lost = convoyLossAlong(sent, land.steps);
    expect(lost).toBeLessThan(convoyLossAlong(sent, sea.steps));
    expect(text).toContain(
      'send_troops_modal.route_land {"tiles":120,"seconds":12}',
    );
    expect(text).toContain(
      'send_troops_modal.route_hostile {"count":20,"names":"Enemy"}',
    );
    expect(text).toContain('send_troops_modal.route_shells {"count":1}');
    expect(text).toContain(
      `send_troops_modal.expected_loss {"lost":"${lost}","percent":${Math.round(
        (lost / sent) * 100,
      )},"arrive":"${sent - lost}"}`,
    );
  });

  it("says when there is no route", async () => {
    const { modal } = await mount([]);
    expect(modal.querySelector(".convoy-forecast")!.textContent).toContain(
      "send_troops_modal.no_route",
    );
  });
});
