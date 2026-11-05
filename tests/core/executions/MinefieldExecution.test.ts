import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  GameMode,
  MINEFIELD_DEFAULT_DENSITY,
  MessageType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  MINEFIELD_DEPLETION_PER_HIT,
  MINEFIELD_PLACEMENT_RANGE,
  MINEFIELD_RADIUS,
  minefieldCost,
  minefieldCostAtDensity,
  minefieldHitChanceBasisPoints,
} from "@openfront/engine-lib/game/NavalDefense";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { MinefieldExecution } from "@openfront/engine/execution/MinefieldExecution";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// half_land_half_ocean: 16x16, land at x 0-7, ocean at x 8-15.
const MAP = "half_land_half_ocean";
const CENTER = { x: 12, y: 8 };

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

async function navalGame(config: Parameters<typeof setup>[1] = {}) {
  const game = await setup(
    MAP,
    { infiniteGold: false, ...config },
    humans("defender", "attacker", "ally"),
  );
  const defender = game.player("defender");
  const attacker = game.player("attacker");
  const ally = game.player("ally");
  // The defender holds the whole coast; the others a strip each inland.
  conquerRect(game, defender, 4, 0, 8, 16);
  conquerRect(game, attacker, 0, 0, 2, 16);
  conquerRect(game, ally, 2, 0, 4, 16);
  defender.createAllianceRequest(ally)!.accept();
  expect(defender.isFriendly(ally)).toBe(true);
  expect(defender.isFriendly(attacker)).toBe(false);
  return { game, defender, attacker, ally };
}

/**
 * Twenty distinct ocean tiles inside a field at CENTER, snaking along rows
 * 2-4: the "crossing" a ship makes one tile per tick.
 */
function crossing(game: Game): TileRef[] {
  const path: TileRef[] = [];
  for (let x = 8; x <= 15; x++) path.push(game.ref(x, 2));
  for (let x = 15; x >= 8; x--) path.push(game.ref(x, 3));
  for (let x = 8; x <= 11; x++) path.push(game.ref(x, 4));
  return path;
}

/** Lays a field at CENTER straight away and starts its execution. */
function layField(game: Game, owner: Player, density: number): Unit {
  const field = owner.buildUnit(
    UnitType.Minefield,
    game.ref(CENTER.x, CENTER.y),
    {
      density,
    },
  );
  game.addExecution(new MinefieldExecution(field));
  // One tick to init, one for the first check (records ships already inside).
  executeTicks(game, 2);
  return field;
}

/**
 * Moves `ship` along `path`, one tile per tick; stops if it sinks or `stop`
 * says so.
 */
function sail(
  game: Game,
  ship: Unit,
  path: TileRef[],
  stop: () => boolean = () => false,
) {
  for (const tile of path) {
    if (!ship.isActive() || stop()) return;
    ship.move(tile);
    game.executeNextTick();
  }
}

/** The crossing, then back, alternately: `lap` picks the direction. */
function lapPath(game: Game, lap: number): TileRef[] {
  const path = crossing(game);
  return lap % 2 === 0 ? path.slice(1) : path.slice(0, -1).reverse();
}

function transport(game: Game, owner: Player, tile: TileRef): Unit {
  return owner.buildUnit(UnitType.TransportShip, tile, { troops: 1000 });
}

/** Sends `trials` transports of `owner` across a fresh field each; returns sunk count. */
function sunkOverTrials(
  game: Game,
  fieldOwner: Player,
  shipOwner: Player,
  density: number,
  trials: number,
): number {
  const path = crossing(game);
  let sunk = 0;
  for (let i = 0; i < trials; i++) {
    const ship = transport(game, shipOwner, path[0]);
    const field = layField(game, fieldOwner, density);
    sail(game, ship, path.slice(1));
    if (!ship.isActive()) sunk++;
    else ship.delete(false);
    if (field.isActive()) field.delete(false);
    game.executeNextTick();
  }
  return sunk;
}

describe("minefield cost", () => {
  test("scales with density and with fields owned, capped at 3x", () => {
    expect(minefieldCost(100, 0)).toBe(120_000);
    expect(minefieldCost(50, 0)).toBe(60_000);
    expect(minefieldCost(10, 0)).toBe(12_000);
    expect(minefieldCost(100, 1)).toBe(180_000);
    expect(minefieldCost(50, 2)).toBe(120_000);
    expect(minefieldCost(100, 4)).toBe(360_000);
    // Past four owned fields the price stops rising: 3x the first field.
    expect(minefieldCost(100, 10)).toBe(360_000);
    expect(minefieldCost(25, 10)).toBe(90_000);
    // Out-of-range densities are clamped.
    expect(minefieldCost(500, 0)).toBe(120_000);
    expect(minefieldCost(1, 0)).toBe(12_000);
    // A full-density first field stays well under a warship.
    expect(minefieldCost(100, 0)).toBeLessThan(250_000 / 2);
  });

  test("the client scales the default-density price exactly", () => {
    for (const owned of [0, 1, 3, 7]) {
      const atDefault = BigInt(minefieldCost(MINEFIELD_DEFAULT_DENSITY, owned));
      for (const density of [10, 25, 50, 73, 100]) {
        expect(minefieldCostAtDensity(atDefault, density)).toBe(
          BigInt(minefieldCost(density, owned)),
        );
      }
    }
  });

  test("hit odds give ~77% over 20 tiles at full density, ~30% at 25%", () => {
    const crossOdds = (density: number) =>
      1 - (1 - minefieldHitChanceBasisPoints(density) / 10_000) ** 20;
    expect(crossOdds(100)).toBeCloseTo(0.766, 2);
    expect(crossOdds(25)).toBeCloseTo(0.296, 2);
  });

  test("laying charges the price for the chosen density and fields owned", async () => {
    const { game, defender } = await navalGame();
    defender.addGold(1_000_000n);
    const center = game.ref(CENTER.x, CENTER.y);
    const before = defender.gold();
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.Minefield,
        center,
        undefined,
        undefined,
        100,
      ),
    );
    executeTicks(game, 3);
    expect(defender.units(UnitType.Minefield)).toHaveLength(1);
    expect(defender.units(UnitType.Minefield)[0].health()).toBe(100);
    expect(before - defender.gold()).toBe(120_000n);

    // The second field, at 20%, costs 1.5x the base for its density.
    const mid = defender.gold();
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.Minefield,
        game.ref(10, 2),
        undefined,
        undefined,
        20,
      ),
    );
    executeTicks(game, 3);
    expect(defender.units(UnitType.Minefield)).toHaveLength(2);
    expect(mid - defender.gold()).toBe(36_000n);
  });

  test("a build intent without a density lays the default density", async () => {
    const { game, defender } = await navalGame({ infiniteGold: true });
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.Minefield,
        game.ref(CENTER.x, CENTER.y),
      ),
    );
    executeTicks(game, 3);
    const [field] = defender.units(UnitType.Minefield);
    expect(field.health()).toBe(MINEFIELD_DEFAULT_DENSITY);
  });

  test("the menu lists the default-density price and allows the thinnest field", async () => {
    const { game, defender } = await navalGame();
    const center = game.ref(CENTER.x, CENTER.y);
    // Enough for a 10% field but not the 50% default.
    defender.removeGold(defender.gold());
    defender.addGold(20_000n);
    const [bu] = defender.buildableUnits(center, [UnitType.Minefield]);
    expect(bu.cost).toBe(60_000n);
    expect(bu.canBuild).toBe(center);
    // The engine still refuses a density the player can't pay for.
    game.addExecution(
      new MinefieldExecution({ owner: defender, tile: center, density: 50 }),
      new MinefieldExecution({ owner: defender, tile: center, density: 10 }),
    );
    executeTicks(game, 1);
    expect(defender.units(UnitType.Minefield)).toHaveLength(1);
    expect(defender.units(UnitType.Minefield)[0].health()).toBe(10);
    expect(defender.gold()).toBe(8_000n);
  });
});

describe("minefield placement", () => {
  test("only on ocean, never on land", async () => {
    const { game, defender } = await navalGame({ infiniteGold: true });
    expect(defender.canBuild(UnitType.Minefield, game.ref(10, 5))).toBe(
      game.ref(10, 5),
    );
    expect(defender.canBuild(UnitType.Minefield, game.ref(6, 5))).toBe(false);
    expect(defender.canBuild(UnitType.Minefield, game.ref(1, 5))).toBe(false);
  });

  test(`only within ${MINEFIELD_PLACEMENT_RANGE} tiles of own territory`, async () => {
    const game = await setup("world", { infiniteGold: true }, humans("p"));
    const p = game.player("p");
    // A patch of coast (the port tests' site); find ocean near and far.
    conquerRect(game, p, 534, 375, 545, 386);
    const owned = Array.from(p.tiles());
    const distToLand = (t: TileRef) =>
      Math.min(...owned.map((o) => game.euclideanDistSquared(o, t)));
    let near: TileRef | null = null;
    let far: TileRef | null = null;
    for (let x = 480; x < 600 && (near === null || far === null); x++) {
      for (let y = 330; y < 430; y++) {
        const t = game.ref(x, y);
        if (!game.isOcean(t)) continue;
        const d = distToLand(t);
        if (near === null && d >= 15 * 15 && d <= 20 * 20) near = t;
        if (far === null && d > 30 * 30) far = t;
      }
    }
    expect(near).not.toBeNull();
    expect(far).not.toBeNull();
    expect(p.canBuild(UnitType.Minefield, near!)).toBe(near);
    expect(p.canBuild(UnitType.Minefield, far!)).toBe(false);
  });
});

describe("minefield hits", () => {
  test("a hostile transport is hit far more often crossing a full field than a 10% one", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const trials = 40;
    const full = sunkOverTrials(game, defender, attacker, 100, trials);
    const thin = sunkOverTrials(game, defender, attacker, 10, trials);
    // Expected about 77% vs about 13% over 20 tiles.
    expect(full).toBeGreaterThanOrEqual(trials * 0.55);
    expect(thin).toBeLessThanOrEqual(trials * 0.3);
    expect(full).toBeGreaterThan(thin * 2);
  });

  test("own and allied ships are never hit", async () => {
    const { game, defender, ally } = await navalGame({ infiniteGold: true });
    expect(sunkOverTrials(game, defender, defender, 100, 15)).toBe(0);
    expect(sunkOverTrials(game, defender, ally, 100, 15)).toBe(0);
    // The field is still at full density: nothing ever rolled.
    const field = layField(game, defender, 100);
    const ship = transport(game, ally, crossing(game)[0]);
    executeTicks(game, 1);
    sail(game, ship, crossing(game).slice(1));
    expect(ship.isActive()).toBe(true);
    expect(field.health()).toBe(100);
  });

  test("teammates' and disconnected allies' ships are never hit", async () => {
    const game = await setup(
      MAP,
      { infiniteGold: true, gameMode: GameMode.Team, playerTeams: 2 },
      humans("a", "b", "c", "d"),
    );
    const players = ["a", "b", "c", "d"].map((id) => game.player(id));
    const defender = players[0];
    const teammate = players.find(
      (p) => p !== defender && defender.isOnSameTeam(p),
    )!;
    const opponent = players.find(
      (p) => p !== defender && !defender.isOnSameTeam(p),
    )!;
    expect(teammate).toBeDefined();
    expect(opponent).toBeDefined();
    conquerRect(game, defender, 4, 0, 8, 16);
    conquerRect(game, teammate, 2, 0, 4, 16);
    conquerRect(game, opponent, 0, 0, 2, 16);
    expect(sunkOverTrials(game, defender, teammate, 100, 15)).toBe(0);
    expect(sunkOverTrials(game, defender, opponent, 100, 15)).toBeGreaterThan(
      0,
    );

    const {
      game: g2,
      defender: d2,
      ally,
    } = await navalGame({
      infiniteGold: true,
    });
    ally.markDisconnected(true);
    expect(d2.isFriendly(ally)).toBe(false);
    expect(sunkOverTrials(g2, d2, ally, 100, 15)).toBe(0);
  });

  test("trade ships are never hit", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const port = attacker.buildUnit(UnitType.Port, game.ref(1, 8), {});
    const field = layField(game, defender, 100);
    const path = crossing(game);
    for (let i = 0; i < 10; i++) {
      const ship = attacker.buildUnit(UnitType.TradeShip, path[0], {
        targetUnit: port,
      });
      sail(game, ship, path.slice(1));
      expect(ship.isActive()).toBe(true);
      ship.delete(false);
    }
    expect(field.health()).toBe(100);
  });

  test("a ship that sits still inside a field never rolls", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const ship = transport(game, attacker, game.ref(12, 8));
    const field = layField(game, defender, 100);
    executeTicks(game, 300);
    expect(ship.isActive()).toBe(true);
    expect(field.health()).toBe(100);
  });

  test("a hit sinks a transport with its troops, tells both players and depletes the field", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const field = layField(game, defender, 100);
    const path = crossing(game);
    const messages: { message: string; playerID: number | null }[] = [];
    let ship: Unit | null = null;
    // Keep sending transports until one is hit.
    for (let i = 0; i < 20 && field.health() === 100; i++) {
      ship = transport(game, attacker, path[0]);
      executeTicks(game, 1);
      for (const tile of path.slice(1)) {
        if (!ship.isActive()) break;
        ship.move(tile);
        const updates = game.executeNextTick();
        messages.push(...updates[GameUpdateType.DisplayEvent]);
      }
      if (ship.isActive()) ship.delete(false);
    }
    expect(field.health()).toBe(100 - MINEFIELD_DEPLETION_PER_HIT);
    expect(ship!.isActive()).toBe(false);
    expect(ship!.wasDestroyedByEnemy()).toBe(true);
    expect(ship!.destroyer()).toBe(defender);
    const mineMessages = messages.filter((m) =>
      m.message.startsWith("events_display.mine"),
    );
    expect(mineMessages).toEqual([
      expect.objectContaining({
        message: "events_display.mine_hit",
        messageType: MessageType.UNIT_DESTROYED,
        playerID: attacker.smallID(),
        params: { unit: "unit_type.boat", name: defender.displayName() },
      }),
      expect.objectContaining({
        message: "events_display.mine_struck",
        messageType: MessageType.CAPTURED_ENEMY_UNIT,
        playerID: defender.smallID(),
        params: { unit: "unit_type.boat", name: attacker.displayName() },
      }),
    ]);
  });

  test("a warship takes 40% of its max health per hit", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const path = crossing(game);
    const warship = attacker.buildUnit(UnitType.Warship, path[0], {
      patrolTile: path[0],
    });
    const max = warship.maxHealth();
    const field = layField(game, defender, 100);
    // Back and forth along the crossing until the first hit.
    const hit = () => warship.health() < max;
    for (let lap = 0; lap < 20 && !hit(); lap++) {
      sail(game, warship, lapPath(game, lap), hit);
    }
    expect(warship.health()).toBe(max - Math.floor((max * 40) / 100));
    expect(field.health()).toBe(100 - MINEFIELD_DEPLETION_PER_HIT);
    // Three hits sink it: 1000 -> 600 -> 200 -> gone.
    for (let lap = 0; lap < 60 && warship.isActive(); lap++) {
      sail(game, warship, lapPath(game, lap));
    }
    expect(warship.isActive()).toBe(false);
    expect(field.health()).toBe(100 - 3 * MINEFIELD_DEPLETION_PER_HIT);
    expect(warship.destroyer()).toBe(defender);
  });

  test("convoys are hit only at sea", async () => {
    const { game, defender, attacker, ally } = await navalGame({
      infiniteGold: true,
    });
    attacker.createAllianceRequest(ally)!.accept();
    const path = crossing(game);
    let sunk = 0;
    for (let i = 0; i < 10; i++) {
      const convoy = attacker.buildUnit(UnitType.Convoy, path[0], {
        troops: 100,
        targetTile: game.ref(3, 3),
        targetPlayer: ally,
      });
      const field = layField(game, defender, 100);
      sail(game, convoy, path.slice(1));
      if (!convoy.isActive()) sunk++;
      else convoy.delete(false);
      if (field.isActive()) field.delete(false);
      game.executeNextTick();
    }
    expect(sunk).toBeGreaterThan(0);

    // Overland, inside the field's radius, nothing ever rolls.
    const field = layField(game, defender, 100);
    const land: TileRef[] = [];
    for (let y = 0; y < 16; y++) land.push(game.ref(y % 2 === 0 ? 6 : 7, y));
    expect(land.every((t) => game.isLand(t))).toBe(true);
    for (let i = 0; i < 10; i++) {
      const convoy = attacker.buildUnit(UnitType.Convoy, land[0], {
        troops: 100,
        targetTile: game.ref(3, 3),
        targetPlayer: ally,
      });
      sail(game, convoy, land.slice(1));
      expect(convoy.isActive()).toBe(true);
      convoy.delete(false);
    }
    expect(field.health()).toBe(100);
  });
});

describe("minefield depletion and removal", () => {
  test("a field below one hit's depletion is removed by its next hit", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const field = layField(game, defender, MINEFIELD_DEPLETION_PER_HIT);
    const path = crossing(game);
    for (let i = 0; i < 200 && field.isActive(); i++) {
      const ship = transport(game, attacker, path[0]);
      executeTicks(game, 1);
      sail(game, ship, path.slice(1));
      if (ship.isActive()) ship.delete(false);
    }
    expect(field.isActive()).toBe(false);
    executeTicks(game, 1);
    expect(defender.units(UnitType.Minefield)).toHaveLength(0);
  });

  test("a full field survives six hits and goes on the seventh", async () => {
    const { game, defender, attacker } = await navalGame({
      infiniteGold: true,
    });
    const field = layField(game, defender, 100);
    const path = crossing(game);
    const healths: number[] = [];
    for (let i = 0; i < 400 && field.isActive(); i++) {
      const ship = transport(game, attacker, path[0]);
      executeTicks(game, 1);
      sail(game, ship, path.slice(1));
      if (ship.isActive()) ship.delete(false);
      else if (field.isActive()) healths.push(field.health());
    }
    expect(healths).toEqual([85, 70, 55, 40, 25, 10]);
    expect(field.isActive()).toBe(false);
  });

  test("fields go when their owner is eliminated", async () => {
    const { game, defender } = await navalGame({ infiniteGold: true });
    const field = layField(game, defender, 50);
    for (const t of Array.from(defender.tiles())) defender.relinquish(t);
    expect(defender.isAlive()).toBe(false);
    executeTicks(game, 1);
    expect(field.isActive()).toBe(false);
  });

  test("a field covers only its radius", async () => {
    // A field is wider than the naval test map, so this one uses the world
    // map: an open ocean row long enough for the center and a lane just
    // outside the radius.
    const game = await setup(
      "world",
      { infiniteGold: true },
      humans("defender", "attacker"),
    );
    const defender = game.player("defender");
    const attacker = game.player("attacker");
    const map = game.map();
    const r = MINEFIELD_RADIUS;
    let center: TileRef | null = null;
    for (let y = 0; y < map.height() && center === null; y += 7) {
      for (let x = 0; x + r + 9 < map.width() && center === null; x += 7) {
        let open = true;
        for (let dx = 0; dx <= r + 8 && open; dx++) {
          open = map.isOcean(map.ref(x + dx, y));
        }
        if (open) center = map.ref(x, y);
      }
    }
    expect(center).not.toBeNull();
    const field = defender.buildUnit(UnitType.Minefield, center!, {
      density: 100,
    });
    game.addExecution(new MinefieldExecution(field));
    executeTicks(game, 2);
    const lane: TileRef[] = [];
    for (let dx = r + 1; dx <= r + 8; dx++) {
      lane.push(map.ref(map.x(center!) + dx, map.y(center!)));
    }
    const path = [...lane, ...lane.slice(0, -1).reverse()];
    for (const tile of path) {
      expect(game.euclideanDistSquared(tile, center!)).toBeGreaterThan(r * r);
    }
    for (let i = 0; i < 10; i++) {
      const ship = transport(game, attacker, path[0]);
      sail(game, ship, path.slice(1));
      expect(ship.isActive()).toBe(true);
      ship.delete(false);
    }
    expect(field.health()).toBe(100);
  });
});

describe("nations lay minefields", () => {
  test("off their busiest port once an enemy warship comes near", async () => {
    const game = await setup(MAP, { infiniteGold: true }, [
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      ...humans("attacker"),
    ]);
    const nation = game.player("nation");
    const attacker = game.player("attacker");
    conquerRect(game, nation, 4, 0, 8, 16);
    conquerRect(game, attacker, 0, 0, 2, 16);
    nation.addGold(1_000_000n);
    const small = nation.buildUnit(UnitType.Port, game.ref(7, 1), {});
    const busiest = nation.buildUnit(UnitType.Port, game.ref(7, 14), {});
    busiest.increaseLevel();
    const random = new PseudoRandom(42);
    const behavior = new NationWarshipBehavior(
      random,
      game,
      nation,
      new NationEmojiBehavior(random, game, nation),
    );

    // No threat, no mines.
    expect(behavior.maybeLayMinefield()).toBe(false);

    attacker.buildUnit(UnitType.Warship, game.ref(13, 3), {
      patrolTile: game.ref(13, 3),
    });
    const gold = nation.gold();
    expect(behavior.maybeLayMinefield()).toBe(true);
    executeTicks(game, 3);
    const [field] = nation.units(UnitType.Minefield);
    expect(field.health()).toBe(MINEFIELD_DEFAULT_DENSITY);
    expect(gold - nation.gold()).toBe(BigInt(minefieldCost(50, 0)));
    // Off the busier port, covering it.
    expect(
      game.euclideanDistSquared(field.tile(), busiest.tile()),
    ).toBeLessThan(game.euclideanDistSquared(field.tile(), small.tile()));
    expect(
      game.euclideanDistSquared(field.tile(), busiest.tile()),
    ).toBeLessThanOrEqual(MINEFIELD_RADIUS * MINEFIELD_RADIUS);

    // A field is wider than this map, so the one field covers the small
    // port too: every port is mined and no second field is laid.
    expect(
      game.euclideanDistSquared(field.tile(), small.tile()),
    ).toBeLessThanOrEqual(MINEFIELD_RADIUS * MINEFIELD_RADIUS);
    expect(behavior.maybeLayMinefield()).toBe(false);
  });
});
