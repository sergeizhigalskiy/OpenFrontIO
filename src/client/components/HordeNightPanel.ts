import {
  hordeTicksUntilNextWave,
  hordeWavesLanded,
} from "@openfront/engine-lib/game/HordeNight";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import { GameView } from "../view";

/**
 * The Horde Night readout: the wave counter and the countdown to the next
 * wave, from the same schedule the sim lands waves on
 * (engine-lib/game/HordeNight.ts). Embedded by game-right-sidebar so it
 * stacks under the game timer, like the overtime panel. Hidden when the mode
 * is off, during the spawn phase and after a winner.
 */
@customElement("horde-night-panel")
export class HordeNightPanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the countdown advances every second.
  @property({ attribute: false }) refreshKey = 0;

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  private minutesSeconds(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = Math.floor(totalSeconds % 60);
    return `${m}:${s < 10 ? `0${s}` : s}`;
  }

  render() {
    const visible =
      this.game?.config().gameConfig().hordeNight?.enabled === true &&
      !this.hasWinner &&
      !this.game.inSpawnPhase();
    this.style.display = visible ? "block" : "none";
    if (!visible) return html``;

    const ticks = this.game.ticksSinceStart();
    const wave = hordeWavesLanded(ticks);
    const countdown = this.minutesSeconds(
      Math.ceil(hordeTicksUntilNextWave(ticks) / 10),
    );

    // The land the viewer held when the first wave landed: overrun under 25%.
    const me = this.game.myPlayer();
    const start =
      me === null ? null : this.game.cataclysm().hordeStartTiles(me.smallID());
    const held =
      me !== null && start !== null && start > 0
        ? Math.round((me.numTilesOwned() * 100) / start)
        : null;

    const panel =
      "w-fit flex flex-col gap-1 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-l-lg text-white text-sm";

    return html`
      <div class="${panel}">
        <div class="flex items-center justify-between gap-3">
          <span class="font-bold tracking-wide text-red-400">
            ${translateText("horde_night.title")}
          </span>
          ${
            wave > 0
              ? html`<span class="font-bold text-red-300">
                  ${translateText("horde_night.wave", { wave })}
                </span>`
              : ""
          }
        </div>
        <div class="text-xs text-gray-300">
          ${translateText(
            wave > 0 ? "horde_night.next_wave" : "horde_night.first_wave",
            { time: countdown },
          )}
        </div>
        ${
          held !== null
            ? html`<div
                class="text-xs ${held < 50 ? "text-red-300" : "text-gray-300"}"
              >
                ${translateText("horde_night.land_held", { pct: held })}
              </div>`
            : ""
        }
      </div>
    `;
  }
}
