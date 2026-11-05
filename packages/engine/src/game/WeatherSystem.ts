import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Tick } from "@openfront/engine-api/game/GameTypes";
import { WeatherCell } from "@openfront/engine-api/game/GameUpdates";
import type { Unit } from "./Game";

/** How a sea storm affects one ship's move this tick (see stormMove). */
export interface StormMove {
  /** The ship is on water inside an active sea storm: half speed. */
  slowed: boolean;
  /** Skip this tick's move: a slowed ship moves on even ticks only. */
  hold: boolean;
  /**
   * `slowed` differs from this ship's last call: a ship driven by a motion
   * plan records a new one at its new speed.
   */
  changed: boolean;
}

/** No storm: what ships see when weather is off. */
export const CALM: StormMove = { slowed: false, hold: false, changed: false };

/**
 * The live weather systems other code reads (WeatherExecution implements it
 * and registers on the game). Game.weather() is null when weather is off or
 * before the first tick after the spawn phase.
 */
export interface WeatherSystem {
  /** Every live cell, forecasts included. */
  cells(): readonly WeatherCell[];
  /** Multiplier on the tick cost of taking the enemy-owned `tile`: mud. */
  attackTileCostMultiplier(tile: TileRef): number;
  /** True when an active sea storm covers the water tile `tile`. */
  inStorm(tile: TileRef): boolean;
  /**
   * Sea storms: whether `ship` moves this tick. Call once per tick from the
   * ship's execution, before it moves.
   */
  stormMove(ship: Unit, tick: Tick): StormMove;
}

/** Duck-typed, so GameImpl can find a restored WeatherExecution in its execs. */
export function isWeatherSystem(x: object): x is WeatherSystem {
  const w = x as Partial<WeatherSystem>;
  return (
    typeof w.stormMove === "function" &&
    typeof w.attackTileCostMultiplier === "function" &&
    typeof w.inStorm === "function"
  );
}
