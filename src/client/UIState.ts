import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  preventStacking?: boolean;
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /**
   * Shift is held, so a left click on enemy land spearheads toward the
   * clicked tile instead of attacking the whole border (the hover forecast
   * prices whichever a click would send).
   */
  shiftHeld?: boolean;
}
