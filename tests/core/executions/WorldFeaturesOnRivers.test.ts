/**
 * World features meet terrain features: nothing is built on a river or ford,
 * so a city-state's center (its city) and defense post keep off them.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Cell,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { CityStateExecution } from "@openfront/engine/execution/CityStateExecution";
import { CityStateSpawner } from "@openfront/engine/execution/CityStateSpawner";
import { Game } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 tiles of open land.
const MAP = "big_plains";

/** Rivers down every even column: half the map can't hold a structure. */
function riverColumns(game: Game): void {
  vi.spyOn(game.map(), "terrainFeature").mockImplementation((tile) =>
    game.x(tile) % 2 === 0 ? TerrainFeature.River : TerrainFeature.None,
  );
}

describe("world features keep structures off rivers", () => {
  test("city-states found their city and post on dry land", async () => {
    const game = await setup(MAP, {}, [
      new PlayerInfo("a", PlayerType.Human, "c_a", "a"),
    ]);
    riverColumns(game);
    const execs = new CityStateSpawner(game, "rivers_game", [
      new Cell(40, 40),
      new Cell(160, 160),
    ]).spawnCityStates();
    expect(execs.length).toBeGreaterThan(0);
    for (const exec of execs) {
      const center = (exec as unknown as { center: TileRef }).center;
      expect(game.x(center) % 2).toBe(1);
    }
    for (const exec of execs) game.addExecution(exec);
    executeTicks(game, 2);
    const cityStates = game.allPlayers().filter((p) => p.isCityState());
    expect(cityStates.length).toBe(execs.length);
    for (const cs of cityStates) {
      for (const type of [UnitType.City, UnitType.DefensePost]) {
        for (const unit of cs.units(type)) {
          expect(game.terrainFeature(unit.tile()), type).toBe(
            TerrainFeature.None,
          );
        }
      }
    }
    expect(execs[0]).toBeInstanceOf(CityStateExecution);
  });
});
