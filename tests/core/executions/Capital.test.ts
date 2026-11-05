import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  CAPITAL_GOLD_LOSS_PERCENT,
  CAPITAL_HOLD_GOLD_BONUS_MAX_PCT,
  CAPITAL_HOLD_GOLD_BONUS_PCT,
  CAPITAL_PENALTY_COOLDOWN_TICKS,
  CAPITAL_RALLY_PCT,
  CAPITAL_TROOP_LOSS_PERCENT,
  capitalHoldGoldBonusPct,
  capitalRallyTroops,
} from "@openfront/engine-lib/game/ConventionalWar";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { capitalLost, heldEnemyCapitals } from "@openfront/engine/game/Capital";
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
// (20, 20); b holds the east, its capital at (150, 100).
async function capitals(
  names = ["a", "b"],
): Promise<{ game: Game; a: Player; b: Player; players: Player[] }> {
  const { game, players } = await conventionalGame("big_plains", names);
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 60, 60);
  conquerRect(game, b, 100, 0, 200, 200);
  a.setSpawnTile(game.ref(20, 20));
  b.setSpawnTile(game.ref(150, 100));
  return { game, a, b, players };
}

describe("capitals", () => {
  test("are the spawn tile, in conventional war only", async () => {
    const { game, a } = await capitals();
    expect(a.capitalTile()).toBe(game.ref(20, 20));
    expect(a.capitalPenaltyTick()).toBeNull();
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

  test("losing it costs 25% of troops and gold, the gold to the captor, and it stays put", async () => {
    const { game, a, b } = await capitals();
    // A big city no longer draws the capital away.
    structure(game, a, UnitType.City, game.ref(10, 50), 3);
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
    // Fixed at the spawn tile, whoever holds it: the star stays there.
    expect(a.capitalTile()).toBe(game.ref(20, 20));
    expect(a.toUpdate()?.capitalTile).toBe(game.ref(20, 20));
    expect(capitalLost(game, a)).toBe(true);
    expect(a.capitalPenaltyTick()).toBe(game.ticks());
    // Both sides are told.
    const told = shown.mock.calls.map(([message, , player]) => [
      message,
      player,
    ]);
    expect(told).toContainEqual(["events_display.capital_lost", a.id()]);
    expect(told).toContainEqual(["events_display.capital_captured", b.id()]);
  });

  test("the penalty hits at most once per 2 minutes, so ping-pong can't chain it", async () => {
    const { game, a, b } = await capitals();
    a.setTroops(400_000);
    setGold(a, 1_000_000n);
    const capital = a.capitalTile()!;
    b.conquer(capital);
    const troops = a.troops();
    const gold = a.gold();
    // Retaken and lost again inside the window: no second penalty.
    a.conquer(capital);
    executeTicks(game, CAPITAL_PENALTY_COOLDOWN_TICKS - 10);
    a.setTroops(troops);
    setGold(a, gold);
    const shown = vi.spyOn(game, "displayMessage");
    b.conquer(capital);
    expect(a.troops()).toBe(troops);
    expect(a.gold()).toBe(gold);
    expect(shown.mock.calls.map(([message]) => message)).toContain(
      "events_display.capital_lost_no_penalty",
    );
    expect(a.capitalTile()).toBe(capital);
    // Once the window is over it hits again.
    a.conquer(capital);
    executeTicks(game, 10);
    a.setTroops(400_000);
    b.conquer(capital);
    expect(a.troops()).toBe(
      400_000 - (400_000 * CAPITAL_TROOP_LOSS_PERCENT) / 100,
    );
    expect(a.gold()).toBeLessThan(gold);
  });

  test("a friend taking the tile costs nothing", async () => {
    const { game, a, b } = await capitals();
    a.createAllianceRequest(b)!.accept();
    a.setTroops(100_000);
    b.conquer(game.ref(20, 20));
    expect(a.troops()).toBe(100_000);
    expect(a.capitalPenaltyTick()).toBeNull();
  });

  test("troop growth is unchanged while it is lost", async () => {
    const { game, a, b } = await capitals();
    // Lose some other tile first, so the land (and max troops) match.
    b.conquer(game.ref(40, 40));
    a.setTroops(100_000);
    const held = game.config().troopIncreaseRate(a);
    a.conquer(game.ref(40, 40));
    b.conquer(a.capitalTile()!);
    a.setTroops(100_000);
    expect(capitalLost(game, a)).toBe(true);
    expect(game.config().troopIncreaseRate(a)).toBe(held);
  });
});

describe("retaking a capital", () => {
  test("rallies 10% of max troops, once per game", async () => {
    const { game, a, b } = await capitals();
    const capital = a.capitalTile()!;
    b.conquer(capital);
    a.setTroops(10_000);
    const shown = vi.spyOn(game, "displayMessage");
    a.conquer(capital);
    // The max as of the retake, the tile included.
    const max = game.config().maxTroops(a);
    const surge = Math.floor((max * CAPITAL_RALLY_PCT) / 100);
    expect(a.troops()).toBe(10_000 + surge);
    expect(a.capitalRallyUsed()).toBe(true);
    expect(capitalLost(game, a)).toBe(false);
    expect(shown.mock.calls.map(([message]) => message)).toContain(
      "events_display.capital_rally",
    );
    // A second retake only says so.
    b.conquer(capital);
    a.setTroops(10_000);
    shown.mockClear();
    a.conquer(capital);
    expect(a.troops()).toBe(10_000);
    expect(shown.mock.calls.map(([message]) => message)).toContain(
      "events_display.capital_recaptured",
    );
  });

  test("the rally never lifts troops past the max", async () => {
    expect(capitalRallyTroops(0, 1000)).toBe(100);
    expect(capitalRallyTroops(950, 1000)).toBe(50);
    expect(capitalRallyTroops(1000, 1000)).toBe(0);
    const { game, a, b } = await capitals();
    const capital = a.capitalTile()!;
    b.conquer(capital);
    a.setTroops(game.config().maxTroops(a) - 5);
    a.conquer(capital);
    const max = game.config().maxTroops(a);
    expect(a.troops()).toBeLessThanOrEqual(max);
    expect(a.troops()).toBeGreaterThan(max - 1);
  });
});

describe("holding enemy capitals", () => {
  test("+10% gold income each, capped at +30%", () => {
    expect([0, 1, 2, 3, 4].map(capitalHoldGoldBonusPct)).toEqual([
      0,
      CAPITAL_HOLD_GOLD_BONUS_PCT,
      2 * CAPITAL_HOLD_GOLD_BONUS_PCT,
      CAPITAL_HOLD_GOLD_BONUS_MAX_PCT,
      CAPITAL_HOLD_GOLD_BONUS_MAX_PCT,
    ]);
  });

  test("holding 1, 2 and 4 capitals pays +10%, +20% and +30%, and the prize ends with the tile", async () => {
    const { game, players } = await conventionalGame("big_plains", [
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    const [a, ...others] = players;
    conquerRect(game, a, 0, 0, 40, 200);
    others.forEach((p, i) => {
      conquerRect(game, p, 60 + i * 30, 0, 85 + i * 30, 200);
      p.setSpawnTile(game.ref(70 + i * 30, 100));
    });
    a.setSpawnTile(game.ref(20, 100));
    game.addExecution(new PlayerExecution(a));
    executeTicks(game, 1);
    const base = game.config().goldAdditionRate(a);

    const income = () => {
      const before = a.gold();
      executeTicks(game, 1);
      return a.gold() - before;
    };
    expect(income()).toBe(base);
    const percents = [110n, 120n, 130n, 130n];
    others.forEach((p, i) => {
      a.conquer(p.capitalTile()!);
      expect(heldEnemyCapitals(game, a)).toBe(i + 1);
      expect(income()).toBe((base * percents[i]) / 100n);
    });
    // Losing a tile ends its share at once.
    for (const p of others.slice(1)) p.conquer(p.capitalTile()!);
    expect(heldEnemyCapitals(game, a)).toBe(1);
    expect(income()).toBe((base * 110n) / 100n);
    others[0].conquer(others[0].capitalTile()!);
    expect(income()).toBe(base);
  });

  test("no prize for a friend's, a tribe's or an eliminated player's capital", async () => {
    const { game, a, b, players } = await capitals(["a", "b", "c"]);
    const c = players[2];
    conquerRect(game, c, 70, 150, 80, 160);
    c.setSpawnTile(game.ref(75, 155));
    const tribe = game.addPlayer(
      new PlayerInfo("tribe", PlayerType.Bot, null, "tribe"),
    );
    conquerRect(game, tribe, 70, 70, 75, 75);
    tribe.setSpawnTile(game.ref(72, 72));
    a.conquer(game.ref(72, 72));
    expect(heldEnemyCapitals(game, a)).toBe(0);

    a.conquer(c.capitalTile()!);
    expect(heldEnemyCapitals(game, a)).toBe(1);
    // c's last tiles: c is gone, and so is the prize.
    conquerRect(game, a, 70, 150, 80, 160);
    expect(c.isAlive()).toBe(false);
    expect(heldEnemyCapitals(game, a)).toBe(0);

    a.conquer(b.capitalTile()!);
    expect(heldEnemyCapitals(game, a)).toBe(1);
    a.createAllianceRequest(b)!.accept();
    expect(heldEnemyCapitals(game, a)).toBe(0);
  });

  test("nothing outside conventional war", async () => {
    const game = await setup("big_plains", {}, [
      new PlayerInfo("p", PlayerType.Human, "c_p", "p"),
      new PlayerInfo("q", PlayerType.Human, "c_q", "q"),
    ]);
    const [p, q] = [game.player("p"), game.player("q")];
    conquerRect(game, q, 100, 100, 110, 110);
    q.setSpawnTile(game.ref(105, 105));
    p.conquer(game.ref(105, 105));
    expect(heldEnemyCapitals(game, p)).toBe(0);
  });
});
