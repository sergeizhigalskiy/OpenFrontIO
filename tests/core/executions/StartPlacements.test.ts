/**
 * The features placed at game start keep out of each other on a real map
 * (the world test map), in their fixed order: city-states, then volcanoes,
 * then gold mines, then ruins (engine/game/StartPlacements.ts). Placed as a
 * real game places them, through GameRunner.init, and the same game id
 * places the same.
 */
import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty } from "@openfront/engine-api/game/GameTypes";
import { VOLCANO_WARNING_RADIUS } from "@openfront/engine-lib/game/Volcanoes";
import { CITY_STATE_RADIUS } from "@openfront/engine-lib/game/WorldFeatures";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { resourceSitesOf } from "@openfront/engine/execution/ResourceSiteExecution";
import { volcanoSitesOf } from "@openfront/engine/execution/VolcanoExecution";
import { Game } from "@openfront/engine/game/Game";
import { MINE_KEEP_OUT_RADIUS } from "@openfront/engine/game/StartPlacements";
import { GameRunner } from "@openfront/engine/GameRunner";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

interface Placed {
  cityStates: TileRef[];
  volcanoes: TileRef[];
  mines: TileRef[];
  ruins: TileRef[];
}

async function placeAll(gameID: string): Promise<{ game: Game; p: Placed }> {
  const game = await setup(
    "world",
    {
      difficulty: Difficulty.Medium,
      volcanoes: true,
      resourceSites: true,
      ruins: true,
      cityStates: true,
    },
    [],
    undefined,
    undefined,
    false,
  );
  new GameRunner(game, new Executor(game, gameID, undefined), () => {}).init();
  executeTicks(game, 2);
  game.endSpawnPhase();
  executeTicks(game, 2);
  return {
    game,
    p: {
      cityStates: game
        .allPlayers()
        .filter((pl) => pl.isCityState())
        .map((pl) => pl.spawnTile()!),
      volcanoes: [...volcanoSitesOf(game)],
      mines: resourceSitesOf(game).map((s) => s.tile),
      ruins: [...game.ruins().keys()],
    },
  };
}

function dist(game: Game, a: TileRef, b: TileRef): number {
  return Math.sqrt(game.euclideanDistSquared(a, b));
}

describe("start features keep out of each other", () => {
  test.each(Array.from({ length: 24 }, (_, i) => `placement_${i}`))(
    "on the world map, in order: city-states, volcanoes, mines, ruins (%s)",
    async (gameID) => {
    const { game, p } = await placeAll(gameID);
    // Every kind is there to check.
    for (const [kind, tiles] of Object.entries(p)) {
      expect(tiles.length, kind).toBeGreaterThan(0);
    }
    for (const cs of p.cityStates) {
      // No volcano's warning ring reaches a city-state's disc.
      for (const v of p.volcanoes) {
        expect(dist(game, cs, v)).toBeGreaterThan(
          VOLCANO_WARNING_RADIUS + CITY_STATE_RADIUS,
        );
      }
      // No mine or ruin inside its disc.
      for (const t of [...p.mines, ...p.ruins]) {
        expect(dist(game, cs, t)).toBeGreaterThan(CITY_STATE_RADIUS);
      }
    }
    // No mine or ruin inside a volcano's warning ring.
    for (const v of p.volcanoes) {
      for (const t of [...p.mines, ...p.ruins]) {
        expect(dist(game, v, t)).toBeGreaterThan(VOLCANO_WARNING_RADIUS);
      }
    }
    // No ruin on or next to a mine.
    for (const m of p.mines) {
      for (const r of p.ruins) {
        expect(dist(game, m, r)).toBeGreaterThan(MINE_KEEP_OUT_RADIUS);
      }
    }
    },
    120_000,
  );

  test("the same game id places the same", async () => {
    const a = await placeAll("placement_game");
    const b = await placeAll("placement_game");
    expect(b.p).toEqual(a.p);
  }, 120_000);
});
