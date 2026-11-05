import {
  INFECTED_PLAYER_ID,
  infectedLandPercent,
  PLAGUE_WORLD_LOSS_PERCENT,
} from "@openfront/engine-lib/game/Plague";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateText } from "../Utils";
import { GameView } from "../view";

/**
 * The plague readout: a meter of The Infected's share of the land, with the
 * share at which everyone loses marked on it (engine-lib/game/Plague.ts).
 * Embedded by game-right-sidebar under the game timer. Shown from the
 * outbreak until The Infected is gone or the game has a winner.
 */
@customElement("plague-panel")
export class PlaguePanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the meter follows the spread.
  @property({ attribute: false }) refreshKey = 0;

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  render() {
    const infected =
      this.game?.config().gameConfig().plague === true &&
      this.game.hasPlayer(INFECTED_PLAYER_ID)
        ? this.game.player(INFECTED_PLAYER_ID)
        : null;
    const visible = infected !== null && infected.isAlive() && !this.hasWinner;
    this.style.display = visible ? "block" : "none";
    if (!visible || infected === null) return html``;

    const pct = infectedLandPercent(
      infected.numTilesOwned(),
      this.game.numLandTiles(),
    );
    const panel =
      "w-fit flex flex-col gap-1.5 py-2 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-l-lg text-white text-sm";

    return html`
      <div class="${panel}">
        <div class="flex items-center justify-between gap-3">
          <span class="font-bold tracking-wide text-lime-400">
            ${translateText("plague.title")}
          </span>
          <span class="text-xs text-gray-300">
            ${translateText("plague.lost_at", {
              pct: PLAGUE_WORLD_LOSS_PERCENT,
            })}
          </span>
        </div>
        <div class="relative h-2.5 w-52 overflow-hidden rounded bg-gray-600/60">
          <!-- the infected share of the land vs the share that loses the game -->
          <div
            class="absolute inset-y-0 left-0 bg-lime-500"
            style="width:${Math.min(100, pct)}%"
          ></div>
          <div
            class="absolute inset-y-0 w-0.5 bg-red-500"
            style="left:${PLAGUE_WORLD_LOSS_PERCENT}%"
          ></div>
        </div>
        <div class="text-xs text-lime-300">
          ${translateText("plague.infected_share", { pct: Math.floor(pct) })}
        </div>
      </div>
    `;
  }
}
