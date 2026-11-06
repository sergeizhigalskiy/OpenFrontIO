import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackIntentSchema } from "@openfront/engine-api/Schemas";
import {
  attackBudgetFront,
  AttackLogicInput,
  SPEAR_BUDGET_FRONT,
} from "@openfront/engine-lib/game/AttackLogic";
import {
  AttackExecution,
  SPEARHEAD_MAX_DELAY,
} from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it, vi } from "vitest";
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

// The spear's tick budget comes from at most a 48-tile front, so it stays a
// trade: the attack goes where you click, at the pace of a 48-tile front.
describe("Spearhead budget cap", () => {
  it("caps a focused attack's front at 48 tiles and leaves broad ones alone", () => {
    expect(SPEAR_BUDGET_FRONT).toBe(48);
    expect(SPEARHEAD_MAX_DELAY).toBe(40);
    expect(attackBudgetFront(200, true)).toBe(48);
    expect(attackBudgetFront(30, true)).toBe(30);
    expect(attackBudgetFront(200, false)).toBe(200);
  });

  /**
   * A (x < 100) attacks D (x >= 100) on big_plains, a straight 200-tile
   * front, with 2x `send` troops against D's 400k; D may have a post at
   * (postX, 100).
   */
  async function front(send: number, postX: number | null) {
    const infos = ["A", "D"].map(
      (n) => new PlayerInfo(n, PlayerType.Human, `c${n}`, `${n}_id`),
    );
    const game = await setup(
      "big_plains",
      { instantBuild: true },
      infos,
      undefined,
      UseRealAttackLogic,
    );
    const A = game.player("A_id");
    const D = game.player("D_id");
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) (x < 100 ? A : D).conquer(game.ref(x, y));
    }
    A.setTroops(send * 2);
    D.setTroops(400_000);
    const post =
      postX === null
        ? null
        : D.buildUnit(UnitType.DefensePost, game.ref(postX, 100), {});
    for (const p of [A, D]) game.addExecution(new PlayerExecution(p));
    game.executeNextTick();
    return { game, A, D, post };
  }

  it("prices each tick from at most 48 front tiles; a broad attack from all 200", async () => {
    for (const focus of [true, false]) {
      const { game, A, D } = await front(100_000, null);
      const inputs: AttackLogicInput[] = [];
      const config = game.config();
      const original = config.attackLogic.bind(config);
      const spy = vi.spyOn(config, "attackLogic").mockImplementation((i) => {
        inputs.push(i);
        return original(i);
      });
      game.addExecution(
        new AttackExecution(
          100_000,
          A,
          D.id(),
          null,
          true,
          focus ? game.ref(140, 100) : null,
        ),
      );
      run(game, 5);
      spy.mockRestore();
      expect(inputs.length).toBeGreaterThan(0);
      for (const { borderSize } of inputs) {
        if (focus) {
          expect(borderSize).toBeLessThanOrEqual(SPEAR_BUDGET_FRONT + 4);
        } else {
          expect(borderSize).toBeGreaterThanOrEqual(200);
        }
      }
    }
  });

  it("takes about 3 s, not half a second, to break a post 25 tiles deep", async () => {
    const { game, A, D, post } = await front(300_000, 125);
    game.addExecution(
      new AttackExecution(300_000, A, D.id(), null, true, game.ref(125, 100)),
    );
    let popped = -1;
    for (let i = 0; i < 80 && popped < 0; i++) {
      game.executeNextTick();
      if (!post!.isActive()) popped = i;
    }
    // 30 ticks measured; uncapped it fell in 5.
    expect(popped).toBeGreaterThanOrEqual(20);
    expect(popped).toBeLessThanOrEqual(45);
  });

  it("starts the flanks within about 4 s, so the spear widens into a front", async () => {
    // A holds the north 60 rows; D a band below it (x 20-179, y 60-139)
    // with T around it. The focus is past D's far side; (160, 60) is 60
    // columns east of the tip, so it waits out the full delay (113 ticks at
    // the old 120-tick cap).
    const infos = ["A", "D", "T"].map(
      (n) => new PlayerInfo(n, PlayerType.Human, `c${n}`, `${n}_id`),
    );
    const game = await setup(
      "big_plains",
      {},
      infos,
      undefined,
      UseRealAttackLogic,
    );
    const A = game.player("A_id");
    const D = game.player("D_id");
    const T = game.player("T_id");
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        const band = x >= 20 && x < 180 && y < 140;
        (y < 60 ? A : band ? D : T).conquer(game.ref(x, y));
      }
    }
    A.setTroops(300_000);
    D.setTroops(400_000);
    T.setTroops(400_000);
    game.addExecution(
      new AttackExecution(150_000, A, D.id(), null, true, game.ref(100, 145)),
    );
    const flank = game.ref(160, 60);
    let flankTick = -1;
    for (let i = 0; i < 120 && flankTick < 0; i++) {
      game.executeNextTick();
      if (game.owner(flank) === A) flankTick = i;
    }
    // 41 ticks measured.
    expect(flankTick).toBeGreaterThan(SPEARHEAD_MAX_DELAY - 10);
    expect(flankTick).toBeLessThanOrEqual(SPEARHEAD_MAX_DELAY + 10);
  });
});
