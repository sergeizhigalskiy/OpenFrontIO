import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { renderTroops } from "@openfront/engine-lib/Format";
import {
  chooseConvoyRoute,
  CONVOY_AMBUSH_DENSITY_MULTIPLIER,
  CONVOY_AMBUSH_PERMILLE,
  CONVOY_COST_HOSTILE_LAND,
  CONVOY_COST_SAFE_LAND,
  CONVOY_COST_WATER,
  CONVOY_MAX_IN_FLIGHT,
  CONVOY_MAX_WATER_CROSSING,
  CONVOY_SHELL_LOSS_PERCENT,
  CONVOY_SHELL_STEP,
  convoyAmbushDensityLoss,
  convoyLossAlong,
  isConvoyHostileTo,
} from "@openfront/engine-lib/game/Convoys";
import { BreakAllianceExecution } from "@openfront/engine/execution/alliance/BreakAllianceExecution";
import { CONVOY_TILES_PER_TICK } from "@openfront/engine/execution/ConvoyExecution";
import {
  convoyRouteOptions,
  planConvoyRoute,
} from "@openfront/engine/execution/ConvoyRoute";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { GameImpl } from "@openfront/engine/game/GameImpl";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

function humans(...ids: string[]): PlayerInfo[] {
  return ids.map((id) => new PlayerInfo(id, PlayerType.Human, null, id));
}

function conquerRect(
  game: Game,
  p: Player,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      const t = game.ref(x, y);
      if (game.isLand(t)) p.conquer(t);
    }
  }
}

function ally(a: Player, b: Player) {
  a.createAllianceRequest(b)!.accept();
  expect(a.isAlliedWith(b)).toBe(true);
}

/** Ticks until `convoy` is gone; returns the ticks it took. */
function runUntilGone(game: Game, convoy: Unit, maxTicks = 500): number {
  let ticks = 0;
  while (convoy.isActive() && ticks < maxTicks) {
    game.executeNextTick();
    ticks++;
  }
  expect(convoy.isActive()).toBe(false);
  return ticks;
}

/** Dispatches a donation and returns the convoy it created. */
function donate(game: Game, sender: Player, recipient: Player, troops: number) {
  const before = new Set(sender.units(UnitType.Convoy));
  game.addExecution(new DonateTroopsExecution(sender, recipient.id(), troops));
  // Tick 1 initializes the donation, tick 2 dispatches the convoy.
  executeTicks(game, 2);
  const convoys = sender.units(UnitType.Convoy).filter((c) => !before.has(c));
  expect(convoys).toHaveLength(1);
  return convoys[0];
}

function hostileTilesOnRoute(
  game: Game,
  route: TileRef[],
  owner: Player,
): number {
  return route.filter((t) => game.owner(t) === owner).length;
}

/** The route a convoy of `troops` would take, with its forecast. */
function chosenRoute(
  game: Game,
  sender: Player,
  recipient: Player,
  troops: number,
) {
  const route = chooseConvoyRoute(
    troops,
    convoyRouteOptions(game, sender, recipient),
  );
  expect(route).not.toBeNull();
  return route!;
}

describe("convoy losses", () => {
  // Hostile tiles of an owner with no troops: only the share is lost.
  const share = (troops: number, tiles: number) =>
    convoyLossAlong(troops, new Array(tiles).fill(0)) / troops;

  test.each([
    [20, 26],
    [50, 53],
    [100, 78],
  ])(
    "crossing %i hostile tiles costs about %i%% of a big or small convoy",
    (tiles, percent) => {
      expect(Math.round(share(1_000_000, tiles) * 100)).toBe(percent);
      expect(Math.round(share(10_000, tiles) * 100)).toBe(percent);
    },
  );

  test("each hostile tile costs 1.5% plus 5 times the owner's troops per tile", () => {
    expect(CONVOY_AMBUSH_PERMILLE).toBe(15);
    expect(CONVOY_AMBUSH_DENSITY_MULTIPLIER).toBe(5);
    // 300k troops on 1,000 tiles: 300 a tile, so 1,500 a tile entered.
    const density = convoyAmbushDensityLoss(300_000, 1_000);
    expect(density).toBe(1_500);
    expect(convoyLossAlong(100_000, [density])).toBe(1_500 + 1_500);
  });

  test("a shell takes 25% of what is left", () => {
    expect(CONVOY_SHELL_LOSS_PERCENT).toBe(25);
    expect(convoyLossAlong(20_000, [CONVOY_SHELL_STEP])).toBe(5_000);
    expect(
      convoyLossAlong(20_000, [CONVOY_SHELL_STEP, CONVOY_SHELL_STEP]),
    ).toBe(5_000 + 3_750);
  });

  test("never loses more than the convoy carries", () => {
    expect(convoyLossAlong(1_000, [10_000, 10_000])).toBe(1_000);
  });

  test("takes the route that loses fewer troops, then the shorter one", () => {
    const land = { length: 40, steps: [0, 0, 0] };
    const sea = { length: 200, steps: [] as number[] };
    expect(chooseConvoyRoute(10_000, [land, sea])).toBe(sea);
    const safeLand = { length: 40, steps: [] as number[] };
    expect(chooseConvoyRoute(10_000, [safeLand, sea])).toBe(safeLand);
    expect(chooseConvoyRoute(10_000, [])).toBeNull();
  });
});

describe("troop convoys over land", () => {
  // Plains is all land, 100 x 100. The sender sits on the west edge, the
  // recipient 40 tiles east; a third player's land can be dropped in between.
  async function landGame() {
    const game = await setup(
      "plains",
      { donateTroops: true },
      humans("sender", "recipient", "third", "fourth"),
    );
    const sender = game.player("sender");
    const recipient = game.player("recipient");
    const third = game.player("third");
    const fourth = game.player("fourth");
    conquerRect(game, sender, 0, 40, 10, 60);
    conquerRect(game, recipient, 50, 40, 60, 60);
    ally(sender, recipient);
    sender.setTroops(100_000);
    recipient.setTroops(0);
    third.setTroops(0);
    fourth.setTroops(0);
    return { game, sender, recipient, third, fourth };
  }

  /** The third player holds a north-south wall the route must cross. */
  function buildWall(game: Game, third: Player) {
    conquerRect(game, third, 25, 0, 35, 100);
  }

  test("troops leave the sender at once and reach the recipient after travel", async () => {
    const { game, sender, recipient } = await landGame();
    const route = planConvoyRoute(game, sender, recipient, 20_000)!;
    expect(route).not.toBeNull();
    expect(game.owner(route[0])).toBe(sender);
    expect(game.owner(route[route.length - 1])).toBe(recipient);

    const convoy = donate(game, sender, recipient, 20_000);
    expect(convoy.type()).toBe(UnitType.Convoy);
    expect(convoy.troops()).toBe(20_000);
    expect(convoy.targetPlayer()).toBe(recipient);
    expect(sender.troops()).toBe(80_000);
    expect(recipient.troops()).toBe(0);
    // The donation cooldown (10 s) starts with the dispatch.
    expect(game.config().donateCooldown()).toBe(100);
    expect(sender.canDonateTroops(recipient)).toBe(false);

    const start = convoy.tile();
    executeTicks(game, 10);
    expect(convoy.isActive()).toBe(true);
    expect(convoy.tile()).not.toBe(start);
    expect(recipient.troops()).toBe(0);

    const ticks = 10 + runUntilGone(game, convoy);
    // One tile per tick: the last tile is the recipient's.
    expect(CONVOY_TILES_PER_TICK).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(route.length - 2);
    expect(convoy.reachedTarget()).toBe(true);
    expect(recipient.troops()).toBe(20_000);
    expect(sender.troops()).toBe(80_000);
  });

  test("delivery reports the donation to both players", async () => {
    const { game, sender, recipient } = await landGame();
    const convoy = donate(game, sender, recipient, 20_000);
    const events: unknown[] = [];
    while (convoy.isActive()) {
      const updates = game.executeNextTick();
      events.push(...updates[GameUpdateType.DonateEvent]);
    }
    expect(events).toEqual([
      {
        type: GameUpdateType.DonateEvent,
        donationType: "troops",
        senderId: sender.id(),
        recipientId: recipient.id(),
        amount: 20_000n,
      },
    ]);
  });

  test("delivers only up to the recipient's troop cap and returns the rest", async () => {
    const { game, sender, recipient } = await landGame();
    const convoy = donate(game, sender, recipient, 20_000);
    // The recipient fills up while the convoy is on the road.
    const cap = Math.floor(game.config().maxTroops(recipient));
    recipient.setTroops(cap - 5_000);
    runUntilGone(game, convoy);
    expect(recipient.troops()).toBe(cap);
    expect(sender.troops()).toBe(80_000 + 15_000);
  });

  test("overflow goes back only up to the sender's own cap; the rest is lost, with a message", async () => {
    const { game, sender, recipient } = await landGame();
    const messages = vi.spyOn(game, "displayMessage");
    const convoy = donate(game, sender, recipient, 20_000);
    const recipientCap = Math.floor(game.config().maxTroops(recipient));
    const senderCap = Math.floor(game.config().maxTroops(sender));
    // 15k won't fit at the recipient, and the sender has room for only 5k.
    recipient.setTroops(recipientCap - 5_000);
    sender.setTroops(senderCap - 5_000);
    runUntilGone(game, convoy);
    expect(recipient.troops()).toBe(recipientCap);
    expect(sender.troops()).toBe(senderCap);
    const lost = messages.mock.calls.filter(
      (c) => c[0] === "events_display.convoy_troops_lost",
    );
    expect(lost).toHaveLength(1);
    expect(lost[0][2]).toBe(sender.id());
    expect(lost[0][4]).toEqual({
      name: recipient.displayName(),
      troops: renderTroops(10_000),
    });
  });

  test("in-transit troops still count toward the sender's growth", async () => {
    const { game, sender, recipient } = await landGame();
    const before = game.config().troopIncreaseRate(sender);
    const convoy = donate(game, sender, recipient, 40_000);
    expect(sender.troops()).toBe(60_000);
    // Growth is what it was with all 100k at home, not the faster growth of
    // a player holding 60k.
    expect(game.config().troopIncreaseRate(sender)).toBeCloseTo(before, 6);
    const atHome = await landGame();
    atHome.sender.setTroops(60_000);
    expect(
      atHome.game.config().troopIncreaseRate(atHome.sender),
    ).toBeGreaterThan(before);
    runUntilGone(game, convoy);
  });

  test("at most 2 convoys in flight per sender", async () => {
    const { game, sender, recipient, third, fourth } = await landGame();
    conquerRect(game, third, 50, 0, 60, 20);
    conquerRect(game, fourth, 50, 80, 60, 100);
    ally(sender, third);
    ally(sender, fourth);
    expect(CONVOY_MAX_IN_FLIGHT).toBe(2);
    donate(game, sender, recipient, 10_000);
    donate(game, sender, third, 10_000);
    expect(sender.canDonateTroops(fourth)).toBe(false);
    game.addExecution(new DonateTroopsExecution(sender, fourth.id(), 10_000));
    executeTicks(game, 2);
    expect(sender.units(UnitType.Convoy)).toHaveLength(2);
    expect(sender.troops()).toBe(80_000);
  });

  test("crossing a hostile player's land costs 1.5% plus 5x its troop density a tile", async () => {
    const { game, sender, recipient, third } = await landGame();
    buildWall(game, third);
    third.setTroops(100_000);
    const route = planConvoyRoute(game, sender, recipient, 50_000)!;
    // The wall is 10 tiles thick and the route crosses it straight.
    expect(hostileTilesOnRoute(game, route, third)).toBe(10);

    const forecast = chosenRoute(game, sender, recipient, 50_000);
    expect(forecast.hostileTiles).toBe(10);
    expect(forecast.crossed).toEqual([third.id()]);
    const perTile = Math.floor(
      (third.troops() * CONVOY_AMBUSH_DENSITY_MULTIPLIER) /
        third.numTilesOwned(),
    );
    expect(forecast.steps).toEqual(new Array(10).fill(perTile));

    const convoy = donate(game, sender, recipient, 50_000);
    runUntilGone(game, convoy);

    // The forecast the donate panel shows is what the convoy loses.
    let expected = 50_000;
    for (let i = 0; i < 10; i++) {
      expected -= Math.ceil((expected * 15) / 1000) + perTile;
    }
    expect(recipient.troops()).toBe(expected);
    expect(recipient.troops()).toBe(
      50_000 - convoyLossAlong(50_000, forecast.steps),
    );
    // The ambush does not cost the ambusher anything.
    expect(third.troops()).toBe(100_000);
  });

  test("weak land is cheaper to cross than strong land", async () => {
    const strong = await landGame();
    buildWall(strong.game, strong.third);
    strong.third.setTroops(200_000);
    runUntilGone(
      strong.game,
      donate(strong.game, strong.sender, strong.recipient, 50_000),
    );

    const weak = await landGame();
    buildWall(weak.game, weak.third);
    weak.third.setTroops(20_000);
    runUntilGone(
      weak.game,
      donate(weak.game, weak.sender, weak.recipient, 50_000),
    );

    expect(weak.recipient.troops()).toBeGreaterThan(strong.recipient.troops());
  });

  test("an ally's land is safe to cross", async () => {
    const { game, sender, recipient, third } = await landGame();
    buildWall(game, third);
    third.setTroops(1_000_000);
    ally(sender, third);
    runUntilGone(game, donate(game, sender, recipient, 50_000));
    expect(recipient.troops()).toBe(50_000);
  });

  test("land friendly with the recipient only is safe too", async () => {
    const { game, sender, recipient, third } = await landGame();
    buildWall(game, third);
    third.setTroops(1_000_000);
    ally(recipient, third);
    expect(sender.isFriendly(third)).toBe(false);
    expect(isConvoyHostileTo(sender, recipient, third)).toBe(false);
    runUntilGone(game, donate(game, sender, recipient, 50_000));
    expect(recipient.troops()).toBe(50_000);
  });

  test("a convoy ambushed down to 0 troops is destroyed", async () => {
    const { game, sender, recipient, third } = await landGame();
    buildWall(game, third);
    third.setTroops(1_000_000);
    const messages = vi.spyOn(game, "displayMessage");

    const convoy = donate(game, sender, recipient, 30_000);
    runUntilGone(game, convoy);

    expect(convoy.reachedTarget()).toBe(false);
    expect(convoy.destroyer()).toBe(third);
    expect(recipient.troops()).toBe(0);
    // Nothing comes back to the sender.
    expect(sender.troops()).toBe(70_000);

    const sentTo = (key: string) =>
      messages.mock.calls
        .filter((c) => c[0] === `events_display.${key}`)
        .map((c) => c[2]);
    expect(sentTo("convoy_destroyed")).toEqual([sender.id()]);
    expect(sentTo("convoy_to_you_destroyed")).toEqual([recipient.id()]);
    expect(sentTo("convoy_destroyed_by_you")).toEqual([third.id()]);
    expect(
      messages.mock.calls.find(
        (c) => c[0] === "events_display.convoy_destroyed_by_you",
      )?.[1],
    ).toBe(MessageType.CAPTURED_ENEMY_UNIT);
  });

  test("disbands and refunds the sender when the alliance breaks en route", async () => {
    const { game, sender, recipient } = await landGame();
    const convoy = donate(game, sender, recipient, 20_000);
    executeTicks(game, 5);
    expect(convoy.isActive()).toBe(true);

    game.addExecution(new BreakAllianceExecution(sender, recipient.id()));
    executeTicks(game, 3);

    expect(convoy.isActive()).toBe(false);
    expect(sender.troops()).toBe(100_000);
    expect(recipient.troops()).toBe(0);
  });

  test("a disband refund also stops at the sender's cap", async () => {
    const { game, sender, recipient } = await landGame();
    const messages = vi.spyOn(game, "displayMessage");
    const convoy = donate(game, sender, recipient, 20_000);
    const senderCap = Math.floor(game.config().maxTroops(sender));
    sender.setTroops(senderCap - 8_000);
    game.addExecution(new BreakAllianceExecution(sender, recipient.id()));
    executeTicks(game, 3);
    expect(convoy.isActive()).toBe(false);
    expect(sender.troops()).toBe(senderCap);
    const lost = messages.mock.calls.find(
      (c) => c[0] === "events_display.convoy_troops_lost",
    );
    expect(lost?.[4]).toEqual({
      name: recipient.displayName(),
      troops: renderTroops(12_000),
    });
  });

  test("disbands and refunds the sender when the recipient dies en route", async () => {
    const { game, sender, recipient } = await landGame();
    const convoy = donate(game, sender, recipient, 20_000);
    executeTicks(game, 5);
    for (const t of Array.from(recipient.tiles())) recipient.relinquish(t);
    expect(recipient.isAlive()).toBe(false);
    executeTicks(game, 2);

    expect(convoy.isActive()).toBe(false);
    expect(sender.troops()).toBe(100_000);
  });

  test("a hostile defense post in range shells the convoy once, for 25%", async () => {
    const { game, sender, recipient, third } = await landGame();
    // An outpost north of the road, within defense post range of it but
    // off the route itself.
    conquerRect(game, third, 28, 20, 33, 25);
    const post = third.buildUnit(UnitType.DefensePost, game.ref(30, 22), {});
    game.addExecution(new DefensePostExecution(post));
    // Let the post's first reload pass.
    executeTicks(game, game.config().defensePostShellAttackRate() + 1);

    const route = planConvoyRoute(game, sender, recipient, 20_000)!;
    expect(hostileTilesOnRoute(game, route, third)).toBe(0);
    const forecast = chosenRoute(game, sender, recipient, 20_000);
    expect(forecast.shells).toBe(1);
    expect(forecast.steps).toEqual([CONVOY_SHELL_STEP]);

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(15_000);
  });

  test("two hostile posts shell it once each", async () => {
    const { game, sender, recipient, third, fourth } = await landGame();
    // Both within range of the road, on either side of it.
    conquerRect(game, third, 28, 20, 33, 25);
    conquerRect(game, fourth, 28, 60, 33, 65);
    for (const [owner, y] of [
      [third, 22],
      [fourth, 62],
    ] as const) {
      const post = owner.buildUnit(UnitType.DefensePost, game.ref(30, y), {});
      game.addExecution(new DefensePostExecution(post));
    }
    executeTicks(game, game.config().defensePostShellAttackRate() + 1);
    expect(chosenRoute(game, sender, recipient, 20_000).shells).toBe(2);
    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(20_000 - 5_000 - 3_750);
  });

  test("a friendly defense post leaves the convoy alone", async () => {
    const { game, sender, recipient } = await landGame();
    const post = sender.buildUnit(UnitType.DefensePost, game.ref(9, 45), {});
    game.addExecution(new DefensePostExecution(post));
    executeTicks(game, game.config().defensePostShellAttackRate() + 1);

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(20_000);
  });

  test("donating to a non-ally sends nothing", async () => {
    const { game, sender, third } = await landGame();
    conquerRect(game, third, 70, 40, 80, 60);
    game.addExecution(new DonateTroopsExecution(sender, third.id(), 20_000));
    executeTicks(game, 3);
    expect(sender.units(UnitType.Convoy)).toHaveLength(0);
    expect(sender.troops()).toBe(100_000);
  });
});

describe("convoy routes", () => {
  // The sender and recipient hold row 50 of the plains, 40 tiles apart, so
  // the straight road is row 50; a block of land or water centred on it sits
  // in between, 10 tiles wide (x 25 to 34) for land.
  async function routeGame() {
    const game = await setup(
      "plains",
      { donateTroops: true },
      humans("sender", "recipient", "third"),
    );
    const sender = game.player("sender");
    const recipient = game.player("recipient");
    const third = game.player("third");
    conquerRect(game, sender, 0, 50, 10, 51);
    conquerRect(game, recipient, 50, 50, 60, 51);
    ally(sender, recipient);
    sender.setTroops(100_000);
    recipient.setTroops(0);
    return { game, sender, recipient, third };
  }

  /** The cost of the tiles a route enters, by the planner's rules. */
  function routeCost(game: Game, sender: Player, recipient: Player) {
    const route = chosenRoute(game, sender, recipient, 10_000);
    const option = convoyRouteOptions(game, sender, recipient).find(
      (o) => o.length === route.length && o.mode === route.mode,
    )!;
    let cost = 0;
    for (const tile of option.tiles.slice(1)) {
      if (!game.isLand(tile)) {
        cost += CONVOY_COST_WATER;
        continue;
      }
      const owner = game.owner(tile);
      cost +=
        owner.isPlayer() && isConvoyHostileTo(sender, recipient, owner)
          ? CONVOY_COST_HOSTILE_LAND
          : CONVOY_COST_SAFE_LAND;
    }
    return { route, tiles: option.tiles, cost };
  }

  test("tile costs: safe land 1, water 2, hostile land 4", () => {
    expect(CONVOY_COST_SAFE_LAND).toBe(1);
    expect(CONVOY_COST_WATER).toBe(2);
    expect(CONVOY_COST_HOSTILE_LAND).toBe(4);
    expect(CONVOY_MAX_WATER_CROSSING).toBe(6);
  });

  test("goes around hostile land when the detour costs less than 3 extra a tile", async () => {
    // 21 rows tall: crossing costs 30 more than open land, going round 24.
    const { game, sender, recipient, third } = await routeGame();
    conquerRect(game, third, 25, 40, 35, 61);
    const { route, tiles, cost } = routeCost(game, sender, recipient);
    expect(route.hostileTiles).toBe(0);
    expect(route.steps).toEqual([]);
    // All safe land, and longer than the straight road it leaves.
    expect(cost).toBe(route.length);
    const straight = game.manhattanDist(tiles[0], tiles[tiles.length - 1]);
    expect(route.length).toBeGreaterThan(straight);
  });

  test("crosses hostile land when going round costs more", async () => {
    // 41 rows tall: going round costs 44 more, crossing 30.
    const { game, sender, recipient, third } = await routeGame();
    conquerRect(game, third, 25, 30, 35, 71);
    const { route, cost } = routeCost(game, sender, recipient);
    expect(route.hostileTiles).toBe(10);
    // 10 hostile tiles at 4 plus the rest of the road at 1.
    expect(cost).toBe(route.length - 10 + 10 * CONVOY_COST_HOSTILE_LAND);
  });

  test("never enters city-state land, and city-states never ambush", async () => {
    const { game, sender, recipient, third } = await routeGame();
    conquerRect(game, third, 25, 30, 35, 71);
    third.markCityState();
    third.setTroops(1_000_000);
    expect(isConvoyHostileTo(sender, recipient, third)).toBe(false);
    const { route, tiles } = routeCost(game, sender, recipient);
    expect(tiles.some((t) => game.owner(t) === third)).toBe(false);
    expect(route.hostileTiles).toBe(0);
    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(20_000);
  });

  test("bridges water up to 6 tiles wide and goes round wider water", async () => {
    // A river 6 tiles wide from top to bottom: crossed.
    const narrow = await routeGame();
    for (let x = 30; x < 36; x++) {
      for (let y = 0; y < 100; y++) {
        (narrow.game as GameImpl).setWater(narrow.game.ref(x, y));
      }
    }
    const crossed = routeCost(narrow.game, narrow.sender, narrow.recipient);
    expect(crossed.route.mode).toBe("land");
    expect(crossed.tiles.filter((t) => !narrow.game.isLand(t))).toHaveLength(6);
    expect(crossed.cost).toBe(crossed.route.length + 6);

    // 7 tiles wide: no overland route, and neither side has a shore.
    const wide = await routeGame();
    for (let x = 30; x < 37; x++) {
      for (let y = 0; y < 100; y++) {
        (wide.game as GameImpl).setWater(wide.game.ref(x, y));
      }
    }
    expect(convoyRouteOptions(wide.game, wide.sender, wide.recipient)).toEqual(
      [],
    );
    expect(planConvoyRoute(wide.game, wide.sender, wide.recipient, 10)).toBe(
      null,
    );
  });

  test("water costs 2 a tile: a 3-wide pond is crossed, a 6-wide sliver is not", async () => {
    // 3 wide, 5 tall: crossing costs 3 more, going round 8.
    const pond = await routeGame();
    for (let x = 30; x < 33; x++) {
      for (let y = 48; y < 53; y++) {
        (pond.game as GameImpl).setWater(pond.game.ref(x, y));
      }
    }
    const throughPond = routeCost(pond.game, pond.sender, pond.recipient);
    expect(throughPond.tiles.filter((t) => !pond.game.isLand(t))).toHaveLength(
      3,
    );

    // 6 wide, 1 tall: crossing costs 6 more, going round 4.
    const sliver = await routeGame();
    for (let x = 30; x < 36; x++) {
      (sliver.game as GameImpl).setWater(sliver.game.ref(x, 50));
    }
    const roundSliver = routeCost(sliver.game, sliver.sender, sliver.recipient);
    expect(roundSliver.tiles.every((t) => sliver.game.isLand(t))).toBe(true);
  });
});

describe("troop convoys by sea", () => {
  // World map: Mozambique's coast and the west coast of Madagascar, with
  // about 40 tiles of sea between them.
  async function seaGame() {
    const game = await setup(
      "world",
      { donateTroops: true },
      humans("sender", "recipient", "navy"),
    );
    const sender = game.player("sender");
    const recipient = game.player("recipient");
    const navy = game.player("navy");
    conquerRect(game, sender, 1110, 636, 1145, 650);
    conquerRect(game, recipient, 1170, 636, 1190, 650);
    ally(sender, recipient);
    sender.setTroops(100_000);
    recipient.setTroops(0);
    return { game, sender, recipient, navy };
  }

  test("an overseas ally gets the convoy by sea", async () => {
    const { game, sender, recipient } = await seaGame();
    const route = planConvoyRoute(game, sender, recipient, 20_000)!;
    expect(route).not.toBeNull();
    expect(game.owner(route[0])).toBe(sender);
    expect(game.owner(route[route.length - 1])).toBe(recipient);
    expect(route.some((t) => game.isWater(t))).toBe(true);
    expect(chosenRoute(game, sender, recipient, 20_000).mode).toBe("sea");

    const convoy = donate(game, sender, recipient, 20_000);
    expect(sender.troops()).toBe(80_000);
    executeTicks(game, 10);
    expect(game.isWater(convoy.tile())).toBe(true);
    expect(recipient.troops()).toBe(0);

    runUntilGone(game, convoy);
    expect(recipient.troops()).toBe(20_000);
  });

  test("an enemy warship shells a convoy at sea once, for 25%", async () => {
    const { game, sender, recipient, navy } = await seaGame();
    conquerRect(game, navy, 1100, 600, 1105, 605);
    const route = planConvoyRoute(game, sender, recipient, 20_000)!;
    const midSea = route.find((t, i) => i > 15 && game.isWater(t))!;
    const warship = navy.buildUnit(UnitType.Warship, midSea, {
      patrolTile: midSea,
    });
    game.addExecution(new WarshipExecution(warship));
    expect(chosenRoute(game, sender, recipient, 20_000).shells).toBe(1);

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(15_000);
  });

  test("plans the sea route too and sails when the land route loses more", async () => {
    // Up the Mozambique coast: a hostile band of land lies between the two
    // overland, while the coastal waters are open.
    const { game, sender, recipient, navy } = await seaGame();
    for (const t of Array.from(recipient.tiles())) recipient.relinquish(t);
    conquerRect(game, recipient, 1130, 560, 1160, 575);
    conquerRect(game, navy, 1080, 590, 1170, 620);
    navy.setTroops(100_000);

    const options = convoyRouteOptions(game, sender, recipient);
    const land = options.find((o) => o.mode === "land")!;
    const sea = options.find((o) => o.mode === "sea")!;
    expect(land.hostileTiles).toBeGreaterThan(0);
    expect(convoyLossAlong(20_000, land.steps)).toBeGreaterThan(0);
    expect(convoyLossAlong(20_000, sea.steps)).toBe(0);
    expect(chosenRoute(game, sender, recipient, 20_000).mode).toBe("sea");

    runUntilGone(game, donate(game, sender, recipient, 20_000), 2_000);
    expect(recipient.troops()).toBe(20_000);
  });

  test("a warship friendly with the recipient lets the convoy pass", async () => {
    const { game, sender, recipient, navy } = await seaGame();
    conquerRect(game, navy, 1100, 600, 1105, 605);
    ally(recipient, navy);
    const route = planConvoyRoute(game, sender, recipient, 20_000)!;
    const midSea = route.find((t, i) => i > 15 && game.isWater(t))!;
    const warship = navy.buildUnit(UnitType.Warship, midSea, {
      patrolTile: midSea,
    });
    game.addExecution(new WarshipExecution(warship));
    expect(chosenRoute(game, sender, recipient, 20_000).shells).toBe(0);

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(20_000);
  });
});
