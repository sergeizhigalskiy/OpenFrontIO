import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { AttackIntentSchema } from "@openfront/engine-api/Schemas";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";

// Spearhead attacks: an attack with a focus tile conquers toward that tile
// first, instead of spreading evenly along the whole border (how far ahead
// and how fast: SpearSteering.test.ts).

async function startGame(): Promise<{ game: Game; player: Player }> {
  const info = new PlayerInfo("spear", PlayerType.Human, null, "spear_id");
  const game = await setup(
    "big_plains",
    { infiniteTroops: true },
    [info],
    undefined,
    UseRealAttackLogic,
  );
  game.addExecution(
    new SpawnExecution(
      "game_id",
      game.player(info.id).info(),
      game.ref(100, 100),
    ),
  );
  game.executeNextTick();
  game.executeNextTick();
  return { game, player: game.player(info.id) };
}

/** How far east along row 100 the player holds land from (100, 100). */
function reachEast(game: Game, player: Player): number {
  let x = 100;
  while (game.owner(game.ref(x + 1, 100)) === player) x++;
  return x;
}

function run(game: Game, ticks: number) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

/** 20k troops into free land from the spawn, aimed at `focus` or broad. */
async function expand(focus: [number, number] | null) {
  const { game, player } = await startGame();
  game.addExecution(
    new AttackExecution(
      20000,
      player,
      game.terraNullius().id(),
      null,
      true,
      focus === null ? null : game.ref(...focus),
    ),
  );
  return { game, player };
}

describe("Spearhead attacks", () => {
  it("lead the land they take toward the focus tile, by about 15 tiles", async () => {
    const broad = await expand(null);
    run(broad.game, 400);
    const spear = await expand([190, 100]);
    run(spear.game, 400);
    // The same land, 1,302 tiles; broad reaches x = 120 on row 100, the
    // spearhead 136.
    expect(spear.player.numTilesOwned()).toBe(broad.player.numTilesOwned());
    const lead =
      reachEast(spear.game, spear.player) - reachEast(broad.game, broad.player);
    expect(lead).toBeGreaterThanOrEqual(10);
    expect(lead).toBeLessThanOrEqual(18);
  });

  it("reaches a focus tile past where a broad attack stops", async () => {
    const spear = await expand([130, 100]);
    let spearTicks = -1;
    for (let i = 0; i < 400 && spearTicks < 0; i++) {
      spear.game.executeNextTick();
      if (spear.game.owner(spear.game.ref(130, 100)) === spear.player) {
        spearTicks = i;
      }
    }
    const broad = await expand(null);
    run(broad.game, 400);
    expect(spearTicks).toBeGreaterThan(0);
    expect(broad.game.owner(broad.game.ref(130, 100))).not.toBe(broad.player);
  });

  it("ignores a focus tile that isn't on the map", async () => {
    const { game, player } = await startGame();
    game.addExecution(
      new AttackExecution(
        3000,
        player,
        game.terraNullius().id(),
        null,
        true,
        10_000_000,
      ),
    );
    expect(() => run(game, 20)).not.toThrow();
    expect(player.numTilesOwned()).toBeGreaterThan(30);
  });

  it("accepts a focus tile on the wire and rejects a fractional one", () => {
    const base = { type: "attack", targetID: null, troops: 10 };
    expect(AttackIntentSchema.safeParse(base).success).toBe(true);
    expect(
      AttackIntentSchema.safeParse({ ...base, focusTile: 42 }).success,
    ).toBe(true);
    expect(
      AttackIntentSchema.safeParse({ ...base, focusTile: 4.5 }).success,
    ).toBe(false);
    expect(
      AttackIntentSchema.safeParse({ ...base, focusTile: -1 }).success,
    ).toBe(false);
  });
});
