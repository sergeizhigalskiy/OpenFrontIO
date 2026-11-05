import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import { GameView } from "../view";

/** "m:ss" for a whole number of seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The rising tide readout: a countdown to the next flood wave (orange while
 * the tiles it floods are shown on the map) and the share of the starting
 * land still above water. Embedded by game-right-sidebar under the game
 * timer, like the overtime panel. Hidden while the mode is off, before the
 * tide's first update, and after a winner.
 */
@customElement("rising-tide-panel")
export class RisingTidePanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the countdown advances every second.
  @property({ attribute: false }) refreshKey = 0;

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  render() {
    const on = !!this.game?.config().risingTide() && !this.hasWinner;
    const tide = on ? this.game.cataclysm().tide : null;
    const visible = on && tide !== null;
    this.style.display = visible ? "block" : "none";
    if (!visible || tide === null) return html``;

    const landPct =
      tide.originalLand > 0
        ? Math.floor((this.game.numLandTiles() / tide.originalLand) * 100)
        : 0;
    const warning = tide.warningTiles.length > 0;
    let status: string;
    if (tide.nextWaveTick === null) {
      status = translateText("rising_tide.stopped");
    } else {
      const time = formatCountdown(
        Math.ceil((tide.nextWaveTick - this.game.ticks()) / 10),
      );
      status = translateText(
        warning ? "rising_tide.flooding" : "rising_tide.next_wave",
        { time },
      );
    }

    const panel =
      "w-fit flex flex-col gap-1 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-l-lg text-white text-sm";
    return html`
      <div class="${panel}">
        <div class="flex items-center justify-between gap-3">
          <span class="font-bold tracking-wide text-sky-400">
            ${translateText("rising_tide.title")}
          </span>
          <span
            class="font-bold ${warning ? "text-orange-400" : "text-sky-200"}"
          >
            ${status}
          </span>
        </div>
        <div class="text-xs text-gray-300">
          ${translateText("rising_tide.land_left", { pct: landPct })}
        </div>
      </div>
    `;
  }
}
