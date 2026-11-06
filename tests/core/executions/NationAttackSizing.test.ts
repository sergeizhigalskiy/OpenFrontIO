/**
 * Nation attacks on players are sized by what the front costs (spec, Nation
 * AI): the smallest stack worth sending takes NATION_ATTACK_FRONT_TILES at
 * the attack forecast's loss per tile. Answering an attack comes first and
 * is never held: not by that minimum, not by winter.
 */
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { attackForecast } from "@openfront/engine-lib/game/AttackForecast";
import { SEASON_CYCLE_TICKS } from "@openfront/engine-lib/game/Seasons";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import {
  NATION_ATTACK_FRONT_TILES,
  NationAttackBehavior,
} from "@openfront/engine/execution/nation/NationAttackBehavior";
import { TransportShipExecution } from "@openfront/engine/execution/TransportShipExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";
import { createGame, L, W } from "../pathfinding/_fixtures";

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) p.conquer(game.ref(x, y));
  }
}

function nationInfo(id: string): PlayerInfo {
  return new PlayerInfo(id, PlayerType.Nation, null, id);
}

// Reserve, trigger and expand ratios 0: it sends everything it may.
function behaviorFor(game: Game, player: Player): NationAttackBehavior {
  return new NationAttackBehavior(
    new PseudoRandom(42),
    game,
    player,
    0,
    0,
    0,
    { maybeSendAllianceRequests: vi.fn(), maybeBetray: vi.fn() } as any,
    { maybeSendAttackEmoji: vi.fn(), sendEmoji: vi.fn() } as any,
    { clearSeaLane: vi.fn() } as any,
  );
}

// What the game is sent from now on (a second call on the same game restarts it)
function sent(game: Game) {
  const spy = vi.spyOn(game, "addExecution");
  spy.mockClear();
  const calls = () => spy.mock.calls.map((c) => c[0]);
  return {
    attacks: () =>
      calls()
        .filter((e): e is AttackExecution => e instanceof AttackExecution)
        .map((e) => e.targetID()),
    boats: () =>
      calls()
        .filter((e) => e instanceof TransportShipExecution)
        .map((e) => e["troops"] as number),
  };
}

/** The plains map split down the middle: `nation` west, a 1M-troop `enemy` east. */
async function denseEnemy(difficulty: Difficulty) {
  const game = await setup(
    "plains",
    { difficulty },
    [nationInfo("nation"), nationInfo("enemy")],
    undefined,
    UseRealAttackLogic,
  );
  const nation = game.player("nation");
  const enemy = game.player("enemy");
  conquerRect(game, nation, 0, 0, 50, 100);
  conquerRect(game, enemy, 50, 0, 100, 100);
  enemy.setTroops(1_000_000);
  // Outnumbered past the cheapest ratio, the loss per tile is the same for
  // every stack below 500k: what the forecast prices one front tile at.
  const stack = (troops: number) =>
    attackForecast(game, nation, enemy, game.ref(50, 50), troops, null, false)
      .lossPerTile * NATION_ATTACK_FRONT_TILES;
  return { game, nation, enemy, stack };
}

describe("nation attacks sized by the front's cost", () => {
  it("an attack on a player needs the stack that takes 150 tiles at the forecast's loss", async () => {
    expect(NATION_ATTACK_FRONT_TILES).toBe(150);
    const { game, nation, enemy, stack } = await denseEnemy(Difficulty.Medium);
    const needed = stack(20_000);
    expect(stack(40_000)).toBe(needed);
    expect(needed).toBeGreaterThan(10_000);

    nation.setTroops(Math.floor(needed) - 100);
    const below = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(false);
    expect(below.attacks()).toEqual([]);

    nation.setTroops(Math.ceil(needed) + 100);
    const above = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    expect(above.attacks()).toEqual([enemy.id()]);
  });

  it("an answer is never held by it", async () => {
    const { game, nation, enemy, stack } = await denseEnemy(Difficulty.Medium);
    game.addExecution(new AttackExecution(5_000, enemy, nation.id()));
    executeTicks(game, 1);
    nation.setTroops(Math.floor(stack(20_000) / 2));
    const s = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy, true)).toBe(true);
    expect(s.attacks()).toEqual([enemy.id()]);
  });

  it("a boat attack is raised to that stack when it can spare it", () => {
    // A strait: our coast at y <= 20, the enemy's at y >= 52. The test
    // config prices every tile at 1 troop, so the stack is 150.
    const width = 40;
    const height = 60;
    const grid: string[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) grid.push(y <= 20 || y >= 52 ? L : W);
    }
    const game = createGame(
      { width, height, grid },
      { difficulty: Difficulty.Medium },
    );
    game.addPlayer(nationInfo("nation"));
    game.addPlayer(nationInfo("enemy"));
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    game.map().forEachTile((t) => {
      if (game.map().isLand(t)) (game.y(t) < 30 ? nation : enemy).conquer(t);
    });
    game.endSpawnPhase();
    enemy.setTroops(100);

    // A fifth of 500 is 100: raised to 150.
    nation.setTroops(500);
    const raised = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    expect(raised.boats()).toEqual([NATION_ATTACK_FRONT_TILES]);

    // With only 100 troops it can't spare 150: no boat.
    nation.setTroops(100);
    const held = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(false);
    expect(held.boats()).toEqual([]);
  });
});

describe("answering an attack comes first", () => {
  it("Hard hits back before it grows into free land", async () => {
    const game = await setup("plains", { difficulty: Difficulty.Hard }, [
      nationInfo("nation"),
      nationInfo("enemy"),
    ]);
    const nation = game.player("nation");
    const enemy = game.player("enemy");
    // Free land south of us, the enemy east.
    conquerRect(game, nation, 0, 0, 30, 50);
    conquerRect(game, enemy, 30, 0, 60, 100);
    nation.setTroops(100_000);
    enemy.setTroops(50_000);
    game.addExecution(new AttackExecution(5_000, enemy, nation.id()));
    executeTicks(game, 1);
    const s = sent(game);
    behaviorFor(game, nation).maybeAttack();
    expect(s.attacks()).toEqual([enemy.id()]);
  });

  it("winter never holds joining an ally's war", async () => {
    const game = await setup("plains", { difficulty: Difficulty.Easy }, [
      nationInfo("nation"),
      nationInfo("ally"),
      nationInfo("enemy"),
    ]);
    const [nation, ally, enemy] = ["nation", "ally", "enemy"].map((id) =>
      game.player(id),
    );
    // A snow front (rows 0-29 are snow land) with the enemy.
    conquerRect(game, nation, 0, 0, 50, 20);
    conquerRect(game, enemy, 50, 0, 100, 20);
    conquerRect(game, ally, 0, 20, 100, 40);
    nation.setTroops(100_000);
    enemy.setTroops(10_000);
    vi.spyOn(game, "ticksSinceStart").mockReturnValue(SEASON_CYCLE_TICKS + 100);
    // Easy holds a push of everything into snow, for its own sake.
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(false);
    nation.createAllianceRequest(ally)!.accept();
    ally.target(enemy);
    expect(nation.allies()).toContain(ally);
    const s = sent(game);
    expect(behaviorFor(game, nation).sendAttack(enemy)).toBe(true);
    expect(s.attacks()).toEqual([enemy.id()]);
  });
});
