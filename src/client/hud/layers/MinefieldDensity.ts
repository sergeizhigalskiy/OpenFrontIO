import {
  Gold,
  MINEFIELD_DEFAULT_DENSITY,
  MINEFIELD_MAX_DENSITY,
  MINEFIELD_MIN_DENSITY,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  clampMinefieldDensity,
  minefieldCostAtDensity,
} from "@openfront/engine-lib/game/NavalDefense";
import { html } from "lit";
import { UIState } from "../../UIState";
import { translateText } from "../../Utils";

/** Slider step, in density percent. */
export const MINEFIELD_DENSITY_STEP = 5;

/** The density the next minefield is laid with. */
export function chosenMinefieldDensity(uiState: UIState | undefined): number {
  return clampMinefieldDensity(
    uiState?.minefieldDensity ?? MINEFIELD_DEFAULT_DENSITY,
  );
}

/**
 * What a unit costs as the player has it set up. The engine lists a
 * minefield at the default density; this prices the density on the slider.
 */
export function displayedCost(
  type: UnitType,
  listCost: Gold,
  uiState: UIState | undefined,
): Gold {
  return type === UnitType.Minefield
    ? minefieldCostAtDensity(listCost, chosenMinefieldDensity(uiState))
    : listCost;
}

/**
 * The minefield density slider (10-100%). Styled inline so it works in both
 * the shadow-DOM build menu and the light-DOM build bar. Calls `onChange`
 * after storing the new density in `uiState`.
 */
export function minefieldDensitySlider(uiState: UIState, onChange: () => void) {
  const density = chosenMinefieldDensity(uiState);
  const onInput = (event: Event) => {
    const value = Number((event.target as HTMLInputElement).value);
    uiState.minefieldDensity = clampMinefieldDensity(value);
    onChange();
  };
  return html`
    <label
      class="minefield-density"
      style="display: flex; align-items: center; gap: 8px; color: white; font-size: 12px; padding: 4px 8px; background: rgba(30, 30, 30, 0.9); border-radius: 6px; pointer-events: auto;"
      @pointerdown=${(e: Event) => e.stopPropagation()}
      @keydown=${(e: Event) => e.stopPropagation()}
    >
      <span style="white-space: nowrap; min-width: 9em;">
        ${translateText("build_menu.minefield_density", { percent: density })}
      </span>
      <input
        type="range"
        min=${MINEFIELD_MIN_DENSITY}
        max=${MINEFIELD_MAX_DENSITY}
        step=${MINEFIELD_DENSITY_STEP}
        .value=${String(density)}
        @input=${onInput}
        aria-label=${translateText("build_menu.minefield_density", {
          percent: density,
        })}
      />
    </label>
  `;
}
