import { TileRef } from "@openfront/engine-api/game/GameMap";
import { PlayerInfo, PlayerType } from "@openfront/engine-api/game/GameTypes";
import { AttackIntentSchema } from "@openfront/engine-api/Schemas";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";

// Spearhead attacks: an attack with a focus tile conquers toward that tile
// first, instead of spreading evenly along the whole border.

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

/** Tiles the player owns east of x=110 minus tiles owned west of x=90. */
function eastLean(game: Game, player: Player): number {
  let east = 0;
  let west = 0;
  for (const t of player.tiles()) {
    const x = game.x(t);
    if (x > 110) east++;
    if (x < 90) west++;
  }
  return east - west;
}

function run(game: Game, ticks: number) {
  for (let i = 0; i < ticks; i++) game.executeNextTick();
}

describe("Spearhead attacks", () => {
  it("push toward the focus tile", async () => {
    const broad = await startGame();
    broad.game.addExecution(
      new AttackExecution(3000, broad.player, broad.game.terraNullius().id()),
    );
    run(broad.game, 40);

    const spear = await startGame();
    const focus: TileRef = spear.game.ref(190, 100);
    spear.game.addExecution(
      new AttackExecution(
        3000,
        spear.player,
        spear.game.terraNullius().id(),
        null,
        true,
        focus,
      ),
    );
    run(spear.game, 40);

    // Without a focus the blob grows about evenly; with one it leans hard east.
    expect(Math.abs(eastLean(broad.game, broad.player))).toBeLessThan(40);
    expect(eastLean(spear.game, spear.player)).toBeGreaterThan(80);
  });

  it("reaches the focus well before a broad attack would", async () => {
    const spear = await startGame();
    const focus = spear.game.ref(160, 100);
    spear.game.addExecution(
      new AttackExecution(
        20000,
        spear.player,
        spear.game.terraNullius().id(),
        null,
        true,
        focus,
      ),
    );
    let spearTicks = -1;
    for (let i = 0; i < 400; i++) {
      spear.game.executeNextTick();
      if (spear.game.owner(focus) === spear.player) {
        spearTicks = i;
        break;
      }
    }

    const broad = await startGame();
    const broadFocus = broad.game.ref(160, 100);
    broad.game.addExecution(
      new AttackExecution(20000, broad.player, broad.game.terraNullius().id()),
    );
    let broadTicks = -1;
    for (let i = 0; i < 400; i++) {
      broad.game.executeNextTick();
      if (broad.game.owner(broadFocus) === broad.player) {
        broadTicks = i;
        break;
      }
    }

    expect(spearTicks).toBeGreaterThan(0);
    expect(broadTicks === -1 || spearTicks < broadTicks).toBe(true);
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
