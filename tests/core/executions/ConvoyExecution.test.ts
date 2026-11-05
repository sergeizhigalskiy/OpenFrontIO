import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import { BreakAllianceExecution } from "@openfront/engine/execution/alliance/BreakAllianceExecution";
import {
  CONVOY_AMBUSH_DENSITY_MULTIPLIER,
  CONVOY_SHELL_LOSS_PERCENT,
  planConvoyRoute,
} from "@openfront/engine/execution/ConvoyExecution";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import { DonateTroopsExecution } from "@openfront/engine/execution/DonateTroopExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
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
  game.addExecution(new DonateTroopsExecution(sender, recipient.id(), troops));
  // Tick 1 initializes the donation, tick 2 dispatches the convoy.
  executeTicks(game, 2);
  const convoys = sender.units(UnitType.Convoy);
  expect(convoys).toHaveLength(1);
  return convoys[0];
}

describe("troop convoys over land", () => {
  // Plains is all land. The sender sits on the west edge, the recipient 40
  // tiles east; a third player's land can be dropped in between.
  async function landGame() {
    const game = await setup(
      "plains",
      { donateTroops: true },
      humans("sender", "recipient", "third"),
    );
    const sender = game.player("sender");
    const recipient = game.player("recipient");
    const third = game.player("third");
    conquerRect(game, sender, 0, 40, 10, 60);
    conquerRect(game, recipient, 50, 40, 60, 60);
    ally(sender, recipient);
    sender.setTroops(100_000);
    recipient.setTroops(0);
    third.setTroops(0);
    return { game, sender, recipient, third };
  }

  /** The third player holds a north-south wall the route must cross. */
  function buildWall(game: Game, third: Player) {
    conquerRect(game, third, 25, 0, 35, 100);
  }

  function hostileTilesOnRoute(
    game: Game,
    route: TileRef[],
    owner: Player,
  ): number {
    return route.filter((t) => game.owner(t) === owner).length;
  }

  test("troops leave the sender at once and reach the recipient after travel", async () => {
    const { game, sender, recipient } = await landGame();
    const route = planConvoyRoute(game, sender, recipient)!;
    expect(route).not.toBeNull();
    expect(game.owner(route[0])).toBe(sender);
    expect(game.owner(route[route.length - 1])).toBe(recipient);

    const convoy = donate(game, sender, recipient, 20_000);
    expect(convoy.type()).toBe(UnitType.Convoy);
    expect(convoy.troops()).toBe(20_000);
    expect(convoy.targetPlayer()).toBe(recipient);
    expect(sender.troops()).toBe(80_000);
    expect(recipient.troops()).toBe(0);
    // The donation cooldown starts with the dispatch.
    expect(sender.canDonateTroops(recipient)).toBe(false);

    const start = convoy.tile();
    executeTicks(game, 10);
    expect(convoy.isActive()).toBe(true);
    expect(convoy.tile()).not.toBe(start);
    expect(recipient.troops()).toBe(0);

    const ticks = 10 + runUntilGone(game, convoy);
    // One tile per tick: the last tile is the recipient's.
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

  test("crossing a hostile player's land costs troops by its troop density", async () => {
    const { game, sender, recipient, third } = await landGame();
    buildWall(game, third);
    third.setTroops(100_000);
    const route = planConvoyRoute(game, sender, recipient)!;
    const hostileTiles = hostileTilesOnRoute(game, route, third);
    expect(hostileTiles).toBeGreaterThan(0);

    const convoy = donate(game, sender, recipient, 50_000);
    runUntilGone(game, convoy);

    const perTile = Math.floor(
      (third.troops() * CONVOY_AMBUSH_DENSITY_MULTIPLIER) /
        third.numTilesOwned(),
    );
    expect(perTile).toBeGreaterThan(0);
    expect(recipient.troops()).toBe(50_000 - perTile * hostileTiles);
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

  test("a hostile defense post in range shells the convoy once", async () => {
    const { game, sender, recipient, third } = await landGame();
    // An outpost north of the road, within defense post range of it but
    // off the route itself.
    conquerRect(game, third, 28, 20, 33, 25);
    const post = third.buildUnit(UnitType.DefensePost, game.ref(30, 22), {});
    game.addExecution(new DefensePostExecution(post));
    // Let the post's first reload pass.
    executeTicks(game, game.config().defensePostShellAttackRate() + 1);

    const route = planConvoyRoute(game, sender, recipient)!;
    expect(hostileTilesOnRoute(game, route, third)).toBe(0);

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(
      20_000 - Math.ceil((20_000 * CONVOY_SHELL_LOSS_PERCENT) / 100),
    );
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
    const route = planConvoyRoute(game, sender, recipient)!;
    expect(route).not.toBeNull();
    expect(game.owner(route[0])).toBe(sender);
    expect(game.owner(route[route.length - 1])).toBe(recipient);
    expect(route.some((t) => game.isWater(t))).toBe(true);

    const convoy = donate(game, sender, recipient, 20_000);
    expect(sender.troops()).toBe(80_000);
    executeTicks(game, 10);
    expect(game.isWater(convoy.tile())).toBe(true);
    expect(recipient.troops()).toBe(0);

    runUntilGone(game, convoy);
    expect(recipient.troops()).toBe(20_000);
  });

  test("an enemy warship shells a convoy at sea", async () => {
    const { game, sender, recipient, navy } = await seaGame();
    conquerRect(game, navy, 1100, 600, 1105, 605);
    const route = planConvoyRoute(game, sender, recipient)!;
    const midSea = route.find((t, i) => i > 15 && game.isWater(t))!;
    const warship = navy.buildUnit(UnitType.Warship, midSea, {
      patrolTile: midSea,
    });
    game.addExecution(new WarshipExecution(warship));

    runUntilGone(game, donate(game, sender, recipient, 20_000));
    expect(recipient.troops()).toBe(
      20_000 - Math.ceil((20_000 * CONVOY_SHELL_LOSS_PERCENT) / 100),
    );
  });
});
