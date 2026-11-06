import { PlayerID } from "./GameTypes";

/**
 * One way a troop convoy could go, as the donate panel shows it before the
 * player sends. engine-lib/game/Convoys.ts prices it with the same rule the
 * convoy is hit by.
 */
export interface ConvoyRouteForecast {
  /** Overland (bridging short water crossings) or by sea. */
  mode: "land" | "sea";
  /** Tiles to the delivery; the convoy moves one per tick. */
  length: number;
  /** Hostile land tiles it enters on the way. */
  hostileTiles: number;
  /** Hostile defense posts and warships that will shell it. */
  shells: number;
  /**
   * What it loses, in order: an ambushed tile's flat troop-density loss
   * (0 or more), or CONVOY_SHELL_STEP (-1) for a shell.
   */
  steps: number[];
  /** Hostile players whose land it crosses, in the order it enters it. */
  crossed: PlayerID[];
}
