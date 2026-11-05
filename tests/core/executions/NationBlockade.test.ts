import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { BLOCKADE_RANGE } from "@openfront/engine-lib/game/TradeRoutes";
import {
  blockadedPortToMine,
  considerBlockade,
} from "@openfront/engine/execution/nation/NationBlockadeBehavior";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";

function warship(game: Game, player: Player, x: number, y: number) {
  const tile = game.ref(x, y);
  return player.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

/**
 * World map, west coast of Africa: the enemy's port at (860, 460) and the
 * nation's warships out in the Atlantic, 100 tiles west of it.
 */
async function warFixture(difficulty: Difficulty, ships: number, atWar = true) {
  const game = await setup("world", { difficulty, instantBuild: true }, [
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
  ]);
  const nation = game.player("nation");
  const enemy = game.player("enemy");
  nation.conquer(game.ref(900, 470));
  enemy.conquer(game.ref(860, 460));
  const port = enemy.buildUnit(UnitType.Port, game.ref(860, 460), {});
  const spots = [
    [760, 460],
    [750, 455],
  ].slice(0, ships);
  const fleet = spots.map(([x, y]) => warship(game, nation, x, y));
  if (atWar) nation.createAttack(enemy, 100, null, new Set());
  return { game, nation, enemy, port, fleet };
}

const patrolTiles = (fleet: Unit[]) =>
  fleet.map((s) => s.warshipState().patrolTile);

describe("nation blockades", () => {
  it("a Hard nation sends one warship to sit off its war enemy's port", async () => {
    const { game, nation, port, fleet } = await warFixture(Difficulty.Hard, 2);
    const before = patrolTiles(fleet);

    considerBlockade(game, nation);

    const moved = fleet.filter(
      (s, i) => s.warshipState().patrolTile !== before[i],
    );
    expect(moved).toHaveLength(1);
    const tile = moved[0].warshipState().patrolTile!;
    expect(game.isWater(tile)).toBe(true);
    expect(game.manhattanDist(tile, port.tile())).toBe(1);
    expect(game.euclideanDistSquared(tile, port.tile())).toBeLessThanOrEqual(
      BLOCKADE_RANGE * BLOCKADE_RANGE,
    );

    // One blockade at a time.
    const after = patrolTiles(fleet);
    considerBlockade(game, nation);
    expect(patrolTiles(fleet)).toEqual(after);
  });

  it("a Hard nation keeps its only warship home; an Impossible one sends it", async () => {
    const hard = await warFixture(Difficulty.Hard, 1);
    const hardBefore = patrolTiles(hard.fleet);
    considerBlockade(hard.game, hard.nation);
    expect(patrolTiles(hard.fleet)).toEqual(hardBefore);

    const impossible = await warFixture(Difficulty.Impossible, 1);
    considerBlockade(impossible.game, impossible.nation);
    expect(
      impossible.game.manhattanDist(
        impossible.fleet[0].warshipState().patrolTile!,
        impossible.port.tile(),
      ),
    ).toBe(1);
  });

  it.each([Difficulty.Easy, Difficulty.Medium])(
    "an %s nation never blockades",
    async (difficulty) => {
      const { game, nation, fleet } = await warFixture(difficulty, 2);
      const before = patrolTiles(fleet);
      considerBlockade(game, nation);
      expect(patrolTiles(fleet)).toEqual(before);
    },
  );

  it("does not blockade a player it is not at war with", async () => {
    const { game, nation, fleet } = await warFixture(
      Difficulty.Impossible,
      2,
      false,
    );
    const before = patrolTiles(fleet);
    considerBlockade(game, nation);
    expect(patrolTiles(fleet)).toEqual(before);
  });

  it("mines its own blockaded port first, unless it already did", async () => {
    // Land is x 0-7 and ocean x 8-15 on this map.
    const game = await setup("half_land_half_ocean", { instantBuild: true }, [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      new PlayerInfo("enemy", PlayerType.Human, null, "enemy"),
    ]);
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    nation.conquer(game.ref(7, 2));
    enemy.conquer(game.ref(0, 12));
    const port = nation.buildUnit(UnitType.Port, game.ref(7, 2), {});
    expect(blockadedPortToMine(game, nation)).toBeNull();

    warship(game, enemy, 12, 3);
    expect(blockadedPortToMine(game, nation)).toBe(port);

    nation.buildUnit(UnitType.Minefield, game.ref(9, 2), { density: 50 });
    expect(blockadedPortToMine(game, nation)).toBeNull();
  });
});
