import {
  DRONE_SWARM_DEFAULT,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { html, render } from "lit";
import {
  airOrderExtras,
  chosenDroneSwarm,
  droneSwarmSlider,
} from "../../src/client/hud/layers/AirOrders";
import { UIState } from "../../src/client/UIState";

function uiState(extra: Partial<UIState> = {}): UIState {
  return {
    attackRatio: 0.2,
    ghostStructure: null,
    rocketDirectionUp: true,
    upgradeMultiplier: 1,
    ...extra,
  } as UIState;
}

describe("conventional war orders", () => {
  test("an airdrop carries the attack-ratio share, a drone order the swarm size", () => {
    const player = { troops: () => 100_000 };
    expect(airOrderExtras(UnitType.Airdrop, uiState(), player)).toEqual({
      troops: 20_000,
    });
    expect(airOrderExtras(UnitType.Drone, uiState(), player)).toEqual({
      count: DRONE_SWARM_DEFAULT,
    });
    expect(
      airOrderExtras(UnitType.Drone, uiState({ droneSwarmSize: 99 }), player),
    ).toEqual({ count: 20 });
    // Everything else sends nothing extra, and never asks for troops.
    expect(airOrderExtras(UnitType.City, uiState(), undefined)).toEqual({});
  });

  test("the swarm slider stores the size", () => {
    const state = uiState();
    const host = document.createElement("div");
    let changes = 0;
    render(html`${droneSwarmSlider(state, 40_000n, () => changes++)}`, host);
    const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
    expect(slider.min).toBe("1");
    expect(slider.max).toBe("20");
    expect(slider.value).toBe(String(DRONE_SWARM_DEFAULT));
    // (Tests load no translations: the label shows its key.)
    expect(host.textContent).toContain("build_menu.drone_swarm");
    slider.value = "8";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chosenDroneSwarm(state)).toBe(8);
    expect(changes).toBe(1);
  });
});
