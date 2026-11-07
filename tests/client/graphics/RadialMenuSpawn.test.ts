import { vi } from "vitest";

// Mock BuildMenu to avoid importing lit and other ESM-heavy deps in this unit test
vi.mock("../../../src/client/hud/layers/BuildMenu", () => ({
  BuildMenu: class {},
  flattenedBuildTable: [],
}));

// Mock Utils to avoid touching DOM (document) during tests
vi.mock("../../../src/client/Utils", () => ({
  translateText: (key: string) => key,
}));
vi.mock("@openfront/engine-lib/Format", () => ({
  renderNumber: (num: number) => num.toString(),
}));

import { TileRef } from "@openfront/engine-api/game/GameMap";
import { EventBus } from "@openfront/shared/EventBus";
import { PlayerActionHandler } from "../../../src/client/hud/layers/PlayerActionHandler";
import { RadialMenu } from "../../../src/client/hud/layers/RadialMenu";
import {
  centerButtonElement,
  MenuElementParams,
} from "../../../src/client/hud/layers/RadialMenuElements";
import { SendAttackIntentEvent } from "../../../src/client/Transport";
import { UIState } from "../../../src/client/UIState";
import { PlayerView } from "../../../src/client/view";

describe("RadialMenu center button - spawn phase", () => {
  it("clicking the center button during the spawn phase spawns on the tile", () => {
    const tile = 42 as TileRef;
    const handleSpawn = vi.fn();
    const handleAttack = vi.fn();
    const closeMenu = vi.fn();

    const params = {
      tile,
      game: { inSpawnPhase: () => true },
      playerActionHandler: { handleSpawn, handleAttack },
      closeMenu,
    } as unknown as MenuElementParams;

    centerButtonElement.action(params);

    expect(handleSpawn).toHaveBeenCalledExactlyOnceWith(tile);
    expect(handleAttack).not.toHaveBeenCalled();
    expect(closeMenu).toHaveBeenCalled();
  });
});

describe("RadialMenu center button - attack", () => {
  it("attacks the selected player broadly, with no focus tile", () => {
    const tile = 42 as TileRef;
    const handleAttack = vi.fn();
    const myPlayer = { troops: () => 1000 };
    const params = {
      tile,
      game: { inSpawnPhase: () => false },
      myPlayer,
      selected: {
        id: () => "enemy1",
        isFriendly: () => false,
        isDisconnected: () => false,
      },
      playerActionHandler: { handleAttack },
      closeMenu: vi.fn(),
    } as unknown as MenuElementParams;

    centerButtonElement.action(params);

    // Only Shift+left click spearheads; the menu's attack takes the whole border.
    expect(handleAttack).toHaveBeenCalledExactlyOnceWith(myPlayer, "enemy1");
  });

  it("PlayerActionHandler sends that attack without a focus tile", () => {
    const bus = new EventBus();
    const attacks: SendAttackIntentEvent[] = [];
    bus.on(SendAttackIntentEvent, (e) => attacks.push(e));
    const handler = new PlayerActionHandler(bus, {
      attackRatio: 0.5,
    } as UIState);

    handler.handleAttack({ troops: () => 1000 } as PlayerView, "enemy1");

    expect(attacks).toHaveLength(1);
    expect(attacks[0].targetID).toBe("enemy1");
    expect(attacks[0].troops).toBe(500);
    expect(attacks[0].focusTile).toBeNull();
  });
});

describe("RadialMenu teardown", () => {
  it("cleans up DOM elements and window resize listener on leave-lobby", () => {
    const bus = new EventBus();
    const offSpy = vi.spyOn(bus, "off");
    const menu = new RadialMenu(bus, { subMenu: () => [] } as any, {} as any);
    menu.init();
    (menu as any).isVisible = true;

    const removeSpy = vi.spyOn(window, "removeEventListener");
    document.dispatchEvent(new CustomEvent("leave-lobby"));

    expect(removeSpy).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(offSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
    );
    expect(document.querySelector(".radial-menu-container")).toBeNull();
  });
});
