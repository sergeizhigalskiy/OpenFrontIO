import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  CAPITAL_GOLD_LOSS_PERCENT,
  CAPITAL_MOVE_COOLDOWN_TICKS,
  CAPITAL_TROOP_LOSS_PERCENT,
} from "@openfront/engine-lib/game/ConventionalWar";
import { largestTerritoryCenter } from "@openfront/engine/game/Capital";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  setGold,
  structure,
} from "../../util/ConventionalWar";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// big_plains: a holds a block in the west with its spawn (capital) at
// (20, 20); b holds the east.
async function capitals(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"]);
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 60, 60);
  conquerRect(game, b, 100, 0, 200, 200);
  a.setSpawnTile(game.ref(20, 20));
  b.setSpawnTile(game.ref(150, 100));
  return { game, a, b };
}

describe("capitals", () => {
  test("start at the spawn tile in conventional war only", async () => {
    const { game, a } = await capitals();
    expect(a.capitalTile()).toBe(game.ref(20, 20));
    expect(a.capitalMovedTick()).toBeNull();
    // Sent to clients with the player.
    expect(a.toUpdate()?.capitalTile).toBe(game.ref(20, 20));

    const plain = await setup("big_plains", {}, [
      new PlayerInfo("p", PlayerType.Human, "c_p", "p"),
    ]);
    const p = plain.player("p");
    p.setSpawnTile(plain.ref(5, 5));
    expect(p.capitalTile()).toBeUndefined();
    expect(p.toUpdate()?.capitalTile).toBeUndefined();
  });

  test("tribes have none", async () => {
    const { game } = await capitals();
    const bot = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    bot.setSpawnTile(game.ref(80, 80));
    expect(bot.capitalTile()).toBeUndefined();
  });

  test("losing it costs 25% of troops and gold, the gold to the captor, and it moves to the best city", async () => {
    const { game, a, b } = await capitals();
    structure(game, a, UnitType.City, game.ref(40, 10));
    const big = structure(game, a, UnitType.City, game.ref(10, 50), 3);
    a.setTroops(400_000);
    setGold(a, 1_000_000n);
    setGold(b, 0n);
    const shown = vi.spyOn(game, "displayMessage");
    b.conquer(game.ref(20, 20));
    expect(a.troops()).toBe(
      400_000 - (400_000 * CAPITAL_TROOP_LOSS_PERCENT) / 100,
    );
    const gold = (1_000_000n * BigInt(CAPITAL_GOLD_LOSS_PERCENT)) / 100n;
    expect(a.gold()).toBe(1_000_000n - gold);
    expect(b.gold()).toBe(gold);
    expect(a.capitalTile()).toBe(big.tile());
    expect(a.capitalMovedTick()).toBe(game.ticks());
    // Both sides are told.
    const told = shown.mock.calls.map(([message, , player]) => [
      message,
      player,
    ]);
    expect(told).toContainEqual(["events_display.capital_lost", a.id()]);
    expect(told).toContainEqual(["events_display.capital_captured", b.id()]);
  });

  test("without a city it moves near the center of the largest territory", async () => {
    const { game, a, b } = await capitals();
    // A small exclave far away doesn't count.
    conquerRect(game, a, 70, 150, 75, 155);
    b.conquer(game.ref(20, 20));
    const capital = a.capitalTile()!;
    expect(game.owner(capital).id()).toBe(a.id());
    expect(game.x(capital)).toBeGreaterThan(25);
    expect(game.x(capital)).toBeLessThan(35);
    expect(game.y(capital)).toBeGreaterThan(25);
    expect(game.y(capital)).toBeLessThan(35);
    expect(capital).toBe(largestTerritoryCenter(game, a));
  });

  test("moves at most once per 2 minutes, so the penalty can't chain", async () => {
    const { game, a, b } = await capitals();
    a.setTroops(400_000);
    b.conquer(game.ref(20, 20));
    const moved = a.capitalTile()!;
    const troopsAfterFirst = a.troops();
    // Taken again inside the window: no penalty, no move.
    b.conquer(moved);
    expect(a.troops()).toBe(troopsAfterFirst);
    expect(a.capitalTile()).toBe(moved);
    // Once the window ends it moves again, still without a penalty.
    const { PlayerExecution } =
      await import("@openfront/engine/execution/PlayerExecution");
    game.addExecution(new PlayerExecution(a));
    executeTicks(game, CAPITAL_MOVE_COOLDOWN_TICKS - 10);
    expect(a.capitalTile()).toBe(moved);
    const troops = a.troops();
    executeTicks(game, 20);
    expect(a.capitalTile()).not.toBe(moved);
    expect(game.owner(a.capitalTile()!).id()).toBe(a.id());
    // Only regrowth since: no 25% loss.
    expect(a.troops()).toBeGreaterThanOrEqual(troops);
  });

  test("a friend taking the tile costs nothing", async () => {
    const { game, a, b } = await capitals();
    a.createAllianceRequest(b)!.accept();
    a.setTroops(100_000);
    b.conquer(game.ref(20, 20));
    expect(a.troops()).toBe(100_000);
    expect(a.capitalMovedTick()).toBeNull();
  });
});
