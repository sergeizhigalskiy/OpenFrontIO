import {
  BuildableUnit,
  DRONE_SWARM_DEFAULT,
  DRONE_SWARM_MAX,
  DRONE_SWARM_MIN,
  Gold,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { renderNumber } from "@openfront/engine-lib/Format";
import { clampDroneSwarm } from "@openfront/engine-lib/game/ConventionalWar";
import { html } from "lit";
import { UIState } from "../../UIState";
import { translateText } from "../../Utils";

/**
 * Client side of the conventional war orders: why one can't go, and what
 * an order carries besides its tile (an airdrop the attack-ratio share of
 * the player's troops, a drone order the swarm size picked on its slider).
 */

/**
 * Why the engine says an air order can't be launched (BuildableUnit.blocked,
 * decided with canBuild by AirOps.airLaunch), as text, or null when it can.
 */
export function airBlockedText(
  unit: BuildableUnit | null | undefined,
): string | null {
  const reason = unit?.blocked;
  return reason === undefined
    ? null
    : translateText(`build_menu.blocked.${reason}`);
}

/** The swarm size the next drone order launches. */
export function chosenDroneSwarm(uiState: UIState | undefined): number {
  return clampDroneSwarm(uiState?.droneSwarmSize ?? DRONE_SWARM_DEFAULT);
}

/** The extra intent fields an order of `type` carries. */
export function airOrderExtras(
  type: UnitType,
  uiState: UIState | undefined,
  player: { troops(): number } | null | undefined,
): { troops?: number; count?: number } {
  switch (type) {
    case UnitType.Airdrop:
      return {
        troops: (uiState?.attackRatio ?? 0.2) * (player?.troops() ?? 0),
      };
    case UnitType.Drone:
      return { count: chosenDroneSwarm(uiState) };
    default:
      return {};
  }
}

/**
 * The drone swarm size slider (1-20) with the swarm's total price. Styled
 * inline so it works in both the shadow-DOM build menu and the light-DOM
 * build bar. Calls `onChange` after storing the size in `uiState`.
 */
export function droneSwarmSlider(
  uiState: UIState,
  droneCost: Gold,
  onChange: () => void,
) {
  const count = chosenDroneSwarm(uiState);
  const label = translateText("build_menu.drone_swarm", {
    count,
    cost: renderNumber(droneCost * BigInt(count)),
  });
  const onInput = (event: Event) => {
    const value = Number((event.target as HTMLInputElement).value);
    uiState.droneSwarmSize = clampDroneSwarm(value);
    onChange();
  };
  return html`
    <label
      class="drone-swarm"
      style="display: flex; align-items: center; gap: 8px; color: white; font-size: 12px; padding: 4px 8px; background: rgba(30, 30, 30, 0.9); border-radius: 6px; pointer-events: auto;"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @keydown=${(e: Event) => e.stopPropagation()}
    >
      <span style="white-space: nowrap; min-width: 12em;">${label}</span>
      <input
        type="range"
        min=${DRONE_SWARM_MIN}
        max=${DRONE_SWARM_MAX}
        step="1"
        .value=${String(count)}
        @input=${onInput}
        aria-label=${label}
      />
    </label>
  `;
}
