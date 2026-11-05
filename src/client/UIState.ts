import { PlayerBuildableUnitType } from "@openfront/engine-api/game/GameTypes";

export interface UIState {
  preventStacking?: boolean;
  attackRatio: number;
  ghostStructure: PlayerBuildableUnitType | null;
  rocketDirectionUp: boolean;
  upgradeMultiplier: number;
  /**
   * Density (integer percent) the next minefield is laid with, from the
   * build menu's slider. Unset means MINEFIELD_DEFAULT_DENSITY.
   */
  minefieldDensity?: number;
  /**
   * Drones the next drone order launches, from the build menu's slider.
   * Unset means DRONE_SWARM_DEFAULT.
   */
  droneSwarmSize?: number;
}
