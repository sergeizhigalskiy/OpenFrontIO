import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  CANAL_COST_PER_TILE,
  CANAL_MAX_LENGTH,
  canalBlockReason,
  canalCost,
  canalPlanFor,
  findCanalPath,
} from "@openfront/engine-lib/game/Canal";
import { Game, Player } from "@openfront/engine/game/Game";
import { at, claim, digLake, digTwoLakes } from "../../util/Canals";
import { setup } from "../../util/Setup";

let game: Game;
let builder: Player;

beforeEach(async () => {
  game = await setup("plains", { instantBuild: true }, [
    new PlayerInfo("builder", PlayerType.Human, "client1", "builder_id"),
  ]);
  builder = game.player("builder_id");
});

describe("findCanalPath", () => {
  test("finds the straight path across a neck between two lakes", () => {
    digTwoLakes(game);
    const found = findCanalPath(game.map(), at(game, 44, 50));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // x 40..47 is land: 8 steps, two rows.
    expect(found.path.length).toBe(8);
    expect(found.path.tiles).toHaveLength(16);
    for (const t of found.path.tiles) expect(game.isLand(t)).toBe(true);
    expect(game.isWater(found.path.waterA)).toBe(true);
    expect(game.isWater(found.path.waterB)).toBe(true);
    // Both rows are dug, side by side.
    const rows = new Set(found.path.tiles.map((t) => game.y(t)));
    expect(rows.size).toBe(2);
  });

  test("is deterministic", () => {
    digTwoLakes(game);
    const a = findCanalPath(game.map(), at(game, 43, 47));
    const b = findCanalPath(game.map(), at(game, 43, 47));
    expect(a).toEqual(b);
  });

  test("rejects a neck longer than the limit", () => {
    // x 40..53 between the lakes: 14 tiles of land.
    digLake(game, 20, 40, 39, 59);
    digLake(game, 54, 40, 73, 59);
    const found = findCanalPath(game.map(), at(game, 46, 50));
    expect(found).toEqual({ ok: false, reason: "no_neck" });
  });

  test("accepts a neck of exactly the limit", () => {
    digLake(game, 20, 40, 39, 59);
    digLake(game, 40 + CANAL_MAX_LENGTH, 40, 70, 59);
    const found = findCanalPath(game.map(), at(game, 45, 50));
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.path.length).toBe(CANAL_MAX_LENGTH);
  });

  test("rejects water ends already joined nearby", () => {
    digTwoLakes(game);
    // Join the lakes over the top of the neck.
    digLake(game, 20, 30, 67, 39);
    const found = findCanalPath(game.map(), at(game, 44, 50));
    expect(found).toEqual({ ok: false, reason: "already_connected" });
  });

  test("accepts one water whose two parts are joined only far away", () => {
    digTwoLakes(game);
    // A long loop south: down the outer sides and across the bottom.
    digLake(game, 20, 60, 22, 95);
    digLake(game, 65, 60, 67, 95);
    digLake(game, 20, 93, 67, 95);
    const found = findCanalPath(game.map(), at(game, 44, 50));
    expect(found.ok).toBe(true);
  });

  test("finds a diagonal path between diagonally placed lakes", () => {
    digLake(game, 20, 20, 35, 35);
    digLake(game, 45, 45, 60, 60);
    const found = findCanalPath(game.map(), at(game, 40, 40));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.path.length).toBeLessThanOrEqual(CANAL_MAX_LENGTH);
    // Not one of the axis-aligned lines.
    const xs = new Set(found.path.tiles.map((t) => game.x(t)));
    const ys = new Set(found.path.tiles.map((t) => game.y(t)));
    expect(xs.size).toBeGreaterThan(2);
    expect(ys.size).toBeGreaterThan(2);
  });

  test("rejects water and land with no water nearby", () => {
    digTwoLakes(game);
    expect(findCanalPath(game.map(), at(game, 30, 50))).toEqual({
      ok: false,
      reason: "not_land",
    });
    expect(findCanalPath(game.map(), at(game, 10, 10))).toEqual({
      ok: false,
      reason: "no_neck",
    });
  });
});

describe("canalBlockReason", () => {
  test("every path tile must be the builder's", () => {
    digTwoLakes(game);
    const tile = at(game, 44, 50);
    expect(canalPlanFor(game.map(), builder, tile)).toMatchObject({
      ok: false,
      reason: "not_owned",
    });
    claim(game, builder, 40, 45, 47, 55);
    const plan = canalPlanFor(game.map(), builder, tile);
    expect(plan.ok).toBe(true);
    // Losing one tile of the path blocks it again.
    if (!plan.ok) return;
    builder.relinquish(plan.path.tiles[3]);
    expect(canalPlanFor(game.map(), builder, tile)).toMatchObject({
      ok: false,
      reason: "not_owned",
    });
  });

  test("no path tile may hold the builder's structures", () => {
    digTwoLakes(game);
    claim(game, builder, 40, 45, 47, 55);
    const found = findCanalPath(game.map(), at(game, 44, 50));
    if (!found.ok) throw new Error("expected a path");
    expect(canalBlockReason(game.map(), builder, found.path)).toBeNull();
    builder.buildUnit(UnitType.City, found.path.tiles[5], {});
    expect(canalBlockReason(game.map(), builder, found.path)).toBe(
      "has_structure",
    );
  });
});

test("a canal costs 150k per step of length", () => {
  expect(CANAL_COST_PER_TILE).toBe(150_000);
  expect(canalCost(CANAL_MAX_LENGTH)).toBe(1_800_000);
});
