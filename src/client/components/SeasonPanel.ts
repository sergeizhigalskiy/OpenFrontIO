import {
  SeasonPhase,
  seasonAt,
  SeasonState,
  WINTER_WARNING_TICKS,
} from "@openfront/engine-lib/game/Seasons";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { showToast, translateText } from "../Utils";
import { GameView } from "../view";

/** How long the season announcements stay up. */
const SEASON_TOAST_MS = 4_000;

/**
 * The season readout: a countdown to the next winter, the 30-second warning,
 * and while a winter lasts, its time left and what it does. Announces the
 * changes ("Winter is coming in 30s", "Winter has arrived", "Spring") as
 * toasts. Embedded by game-right-sidebar under the game timer, like the
 * overtime panel. Hidden during the spawn phase, after a winner, and when the
 * game has seasons off. Reads the same clock as the sim (Seasons.ts).
 */
@customElement("season-panel")
export class SeasonPanel extends LitElement {
  @property({ attribute: false }) game!: GameView;
  @property({ attribute: false }) hasWinner = false;
  // Bumped by the parent each tick so the countdown advances every second.
  @property({ attribute: false }) refreshKey = 0;

  /** The phase last shown, to announce changes; null before the first. */
  private lastPhase: SeasonPhase | null = null;

  // Light DOM so Tailwind classes apply and it stacks in the parent's flex.
  createRenderRoot() {
    return this;
  }

  private season(): SeasonState | null {
    if (
      this.game === undefined ||
      this.hasWinner ||
      !this.game.config().seasonsEnabled() ||
      this.game.inSpawnPhase()
    ) {
      return null;
    }
    return seasonAt(this.game.ticksSinceStart());
  }

  willUpdate(): void {
    const season = this.season();
    const phase = season?.phase ?? null;
    if (
      season !== null &&
      this.lastPhase !== null &&
      phase !== this.lastPhase
    ) {
      announceSeason(season);
    }
    this.lastPhase = phase;
  }

  private clock(ticks: number): string {
    const total = Math.ceil(ticks / 10);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? `0${s}` : s}`;
  }

  render() {
    const season = this.season();
    this.style.display = season === null ? "none" : "block";
    if (season === null) return html``;

    const panel =
      "w-fit flex flex-col gap-0.5 py-1.5 px-4 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-l-lg text-sm";
    switch (season.phase) {
      case SeasonPhase.Fair:
        return html`<div class="${panel} text-white/70" data-season="fair">
          ${translateText("seasons.winter_in", {
            // To the winter itself, past the warning.
            time: this.clock(season.ticksLeft + WINTER_WARNING_TICKS),
          })}
        </div>`;
      case SeasonPhase.Warning:
        return html`<div
          class="${panel} text-amber-300 font-bold animate-pulse"
          data-season="warning"
        >
          ${translateText("seasons.winter_coming", {
            seconds: Math.ceil(season.ticksLeft / 10),
          })}
        </div>`;
      case SeasonPhase.Winter:
        return html`<div class="${panel} text-sky-200" data-season="winter">
          <span class="font-bold">
            ${translateText("seasons.winter_left", {
              time: this.clock(season.ticksLeft),
            })}
          </span>
          <span class="text-xs text-white/70 max-w-56">
            ${translateText("seasons.winter_effects")}
          </span>
        </div>`;
    }
  }
}

/** The toast for entering `season`'s phase. */
export function announceSeason(season: SeasonState): void {
  switch (season.phase) {
    case SeasonPhase.Warning:
      showToast(
        translateText("seasons.winter_coming", {
          seconds: Math.ceil(season.ticksLeft / 10),
        }),
        "red",
        SEASON_TOAST_MS,
      );
      return;
    case SeasonPhase.Winter:
      showToast(
        translateText("seasons.winter_arrived"),
        "red",
        SEASON_TOAST_MS,
      );
      return;
    case SeasonPhase.Fair:
      showToast(translateText("seasons.spring"), "green", SEASON_TOAST_MS);
      return;
  }
}
