import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  COASTAL_BATTERY_RANGE,
  COASTAL_BATTERY_RELOAD_TICKS,
  coastalBatteryCost,
} from "@openfront/engine-lib/game/NavalDefense";
import { CoastalBatteryExecution } from "@openfront/engine/execution/CoastalBatteryExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { WarshipExecution } from "@openfront/engine/execution/WarshipExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { setup } from "../../util/Setup";
import { executeTicks } from "../../util/utils";

// half_land_half_ocean: 16x16, land at x 0-7 (x 7 is the ocean shore),
// ocean at x 8-15.
const MAP = "half_land_half_ocean";
const SHORE_X = 7;

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
    { infiniteGold: true, instantBuild: true, ...config },
    humans("defender", "attacker", "ally"),
  );
  const defender = game.player("defender");
  const attacker = game.player("attacker");
  const ally = game.player("ally");
  conquerRect(game, defender, 4, 0, 8, 16);
  conquerRect(game, attacker, 0, 0, 2, 16);
  conquerRect(game, ally, 2, 0, 4, 16);
  defender.createAllianceRequest(ally)!.accept();
  // Past spawn immunity, so warships may shoot.
  executeTicks(game, 50);
  return { game, defender, attacker, ally };
}

function battery(game: Game, owner: Player, y = 8): Unit {
  const b = owner.buildUnit(UnitType.CoastalBattery, game.ref(SHORE_X, y), {});
  game.addExecution(new CoastalBatteryExecution(b));
  return b;
}

function warship(game: Game, owner: Player, tile: TileRef): Unit {
  return owner.buildUnit(UnitType.Warship, tile, { patrolTile: tile });
}

describe("coastal battery placement and cost", () => {
  test("costs (owned + 1) x 150k, capped at 600k", () => {
    expect(coastalBatteryCost(0)).toBe(150_000);
    expect(coastalBatteryCost(1)).toBe(300_000);
    expect(coastalBatteryCost(3)).toBe(600_000);
    expect(coastalBatteryCost(9)).toBe(600_000);
  });

  test("the engine charges the battery price", async () => {
    const { game, defender } = await navalGame({ infiniteGold: false });
    defender.addGold(1_000_000n);
    const before = defender.gold();
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.CoastalBattery,
        game.ref(SHORE_X, 3),
      ),
    );
    executeTicks(game, 3);
    expect(defender.units(UnitType.CoastalBattery)).toHaveLength(1);
    expect(before - defender.gold()).toBe(150_000n);
    const [bu] = defender.buildableUnits(game.ref(SHORE_X, 12), [
      UnitType.CoastalBattery,
    ]);
    expect(bu.cost).toBe(300_000n);
  });

  test("goes on own land next to ocean, never inland or on water", async () => {
    const { game, defender, ally } = await navalGame();
    // Clicked on the shore: built there.
    const shore = game.ref(SHORE_X, 5);
    expect(defender.canBuild(UnitType.CoastalBattery, shore)).toBe(shore);
    // Clicked a few tiles inland: snaps to the nearest own shore tile.
    const snapped = defender.canBuild(UnitType.CoastalBattery, game.ref(5, 5));
    expect(snapped).not.toBe(false);
    expect(game.isOceanShore(snapped as TileRef)).toBe(true);
    // The ally's land doesn't touch the ocean.
    expect(ally.canBuild(UnitType.CoastalBattery, game.ref(3, 5))).toBe(false);
    // Water is nobody's land.
    expect(defender.canBuild(UnitType.CoastalBattery, game.ref(10, 5))).toBe(
      false,
    );
  });

  test("health is 1.5x a warship's", async () => {
    const { game, defender } = await navalGame();
    const b = battery(game, defender);
    const w = warship(game, defender, game.ref(12, 2));
    expect(b.hasHealth()).toBe(true);
    expect(b.maxHealth()).toBe(1500);
    expect(b.maxHealth()).toBe((w.maxHealth() * 3) / 2);
  });
});

describe("coastal battery fire", () => {
  test("shells a hostile warship in range", async () => {
    const { game, defender, attacker } = await navalGame();
    battery(game, defender);
    const target = warship(game, attacker, game.ref(12, 8));
    const max = target.health();
    let ticks = 0;
    while (target.health() === max && ticks++ < 60) game.executeNextTick();
    // One shell: the same 200-300 damage warship shells deal.
    expect(max - target.health()).toBeGreaterThanOrEqual(200);
    expect(max - target.health()).toBeLessThanOrEqual(300);
    // And it keeps firing, once per reload.
    executeTicks(game, COASTAL_BATTERY_RELOAD_TICKS * 3);
    expect(max - target.health()).toBeGreaterThan(600);
  });

  test("each shell sits on the unit's timer queue until it reloads", async () => {
    // The queue only tells the client about the reload (its reload bar).
    const { game, defender, attacker } = await navalGame();
    const b = battery(game, defender);
    expect(b.missileTimerQueue()).toEqual([]);
    warship(game, attacker, game.ref(12, 8));
    let ticks = 0;
    while (b.missileTimerQueue().length === 0 && ticks++ < 60) {
      game.executeNextTick();
    }
    expect(b.missileTimerQueue()).toHaveLength(1);
    expect(b.isInCooldown()).toBe(true);
    const firedAt = b.missileTimerQueue()[0];
    // Reloading for exactly the reload time, one shell at a time.
    let reloading = 0;
    while (b.missileTimerQueue()[0] === firedAt && reloading < 100) {
      expect(b.missileTimerQueue()).toHaveLength(1);
      game.executeNextTick();
      reloading++;
    }
    // The warship is still in range, so the battery fires again at once.
    expect(b.missileTimerQueue()).toEqual([
      firedAt + COASTAL_BATTERY_RELOAD_TICKS,
    ]);
    expect(reloading).toBe(COASTAL_BATTERY_RELOAD_TICKS);
  });

  test("its timer queue empties once nothing is left to shell", async () => {
    const { game, defender, attacker } = await navalGame();
    const b = battery(game, defender);
    const boat = attacker.buildUnit(UnitType.TransportShip, game.ref(12, 8), {
      troops: 500,
    });
    let ticks = 0;
    while (b.missileTimerQueue().length === 0 && ticks++ < 60) {
      game.executeNextTick();
    }
    expect(b.missileTimerQueue()).toHaveLength(1);
    executeTicks(game, COASTAL_BATTERY_RELOAD_TICKS + 5);
    expect(boat.isActive()).toBe(false);
    expect(b.missileTimerQueue()).toEqual([]);
    expect(b.isInCooldown()).toBe(false);
  });

  test("ignores allied and own warships", async () => {
    const { game, defender, ally } = await navalGame();
    battery(game, defender);
    const allied = warship(game, ally, game.ref(12, 8));
    const own = warship(game, defender, game.ref(13, 4));
    executeTicks(game, 200);
    expect(allied.health()).toBe(allied.maxHealth());
    expect(own.health()).toBe(own.maxHealth());
    expect(defender.units(UnitType.Shell)).toHaveLength(0);
  });

  test("ignores trade ships and anything out of range", async () => {
    const game = await setup(
      "world",
      { infiniteGold: true, instantBuild: true },
      humans("defender", "attacker"),
    );
    const defender = game.player("defender");
    const attacker = game.player("attacker");
    conquerRect(game, defender, 534, 375, 545, 386);
    executeTicks(game, 50);
    const spot = defender.canBuild(UnitType.CoastalBattery, game.ref(539, 380));
    expect(spot).not.toBe(false);
    const b = defender.buildUnit(UnitType.CoastalBattery, spot as TileRef, {});
    game.addExecution(new CoastalBatteryExecution(b));
    // An ocean tile just out of range, and one well inside it.
    let far: TileRef | null = null;
    let near: TileRef | null = null;
    const r = COASTAL_BATTERY_RANGE;
    for (let dx = -r - 10; dx <= r + 10; dx++) {
      for (let dy = -r - 10; dy <= r + 10; dy++) {
        const x = game.x(b.tile()) + dx;
        const y = game.y(b.tile()) + dy;
        if (!game.isValidCoord(x, y)) continue;
        const t = game.ref(x, y);
        if (!game.isOcean(t)) continue;
        const d2 = dx * dx + dy * dy;
        if (far === null && d2 > (r + 2) ** 2 && d2 < (r + 8) ** 2) far = t;
        if (near === null && d2 < 20 * 20 && d2 > 5 * 5) near = t;
      }
    }
    expect(far).not.toBeNull();
    expect(near).not.toBeNull();
    const distant = warship(game, attacker, far!);
    const port = attacker.buildUnit(UnitType.Port, game.ref(539, 380), {});
    const trader = attacker.buildUnit(UnitType.TradeShip, near!, {
      targetUnit: port,
    });
    executeTicks(game, 150);
    expect(distant.health()).toBe(distant.maxHealth());
    expect(trader.isActive()).toBe(true);
    expect(defender.units(UnitType.Shell)).toHaveLength(0);
  });

  test("prefers a warship shelling it, then transports, then other warships", async () => {
    const { game, defender, attacker } = await navalGame();
    const b = battery(game, defender);
    // Nearest: an idle warship. Then a transport. Furthest: a warship
    // targeting the battery.
    const idle = warship(game, attacker, game.ref(9, 8));
    const boat = attacker.buildUnit(UnitType.TransportShip, game.ref(11, 8), {
      troops: 500,
    });
    const assailant = warship(game, attacker, game.ref(14, 8));
    assailant.setTargetUnit(b);

    let ticks = 0;
    while (assailant.health() === assailant.maxHealth() && ticks++ < 60) {
      game.executeNextTick();
    }
    expect(assailant.health()).toBeLessThan(assailant.maxHealth());
    expect(boat.isActive()).toBe(true);
    expect(idle.health()).toBe(idle.maxHealth());

    // Once nothing targets it, the transport goes before the idle warship.
    assailant.setTargetUnit(undefined);
    ticks = 0;
    while (boat.isActive() && ticks++ < COASTAL_BATTERY_RELOAD_TICKS + 30) {
      game.executeNextTick();
    }
    expect(boat.isActive()).toBe(false);
    expect(boat.destroyer()).toBe(defender);
    expect(idle.health()).toBe(idle.maxHealth());
  });

  test("shells a hostile convoy only at sea", async () => {
    const { game, defender, attacker, ally } = await navalGame();
    attacker.createAllianceRequest(ally)!.accept();
    battery(game, defender);
    const atSea = attacker.buildUnit(UnitType.Convoy, game.ref(12, 8), {
      troops: 1000,
      targetTile: game.ref(3, 3),
      targetPlayer: ally,
    });
    let ticks = 0;
    while (atSea.troops() === 1000 && ticks++ < 60) game.executeNextTick();
    expect(atSea.troops()).toBe(500);
  });

  test("does not fire while under construction", async () => {
    const { game, defender, attacker } = await navalGame({
      instantBuild: false,
    });
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.CoastalBattery,
        game.ref(SHORE_X, 8),
      ),
    );
    executeTicks(game, 2);
    const [b] = defender.units(UnitType.CoastalBattery);
    expect(b.isUnderConstruction()).toBe(true);
    const target = warship(game, attacker, game.ref(12, 8));
    executeTicks(game, 30);
    expect(target.health()).toBe(target.maxHealth());
    // Done after its build time, then it opens fire.
    executeTicks(game, 60);
    expect(b.isUnderConstruction()).toBe(false);
    expect(target.health()).toBeLessThan(target.maxHealth());
  });
});

describe("warships against coastal batteries", () => {
  test("a hostile warship shells a battery until it is destroyed", async () => {
    const { game, defender, attacker } = await navalGame();
    // No battery execution: it can't fire back.
    const b = defender.buildUnit(
      UnitType.CoastalBattery,
      game.ref(SHORE_X, 8),
      {},
    );
    const w = warship(game, attacker, game.ref(12, 8));
    game.addExecution(new WarshipExecution(w));
    executeTicks(game, 3);
    expect(w.targetUnit()).toBe(b);
    let ticks = 0;
    while (b.isActive() && ticks++ < 400) game.executeNextTick();
    expect(b.isActive()).toBe(false);
    expect(b.destroyer()).toBe(attacker);
    executeTicks(game, 2);
    expect(defender.units(UnitType.CoastalBattery)).toHaveLength(0);
  });

  test("allied warships leave the battery alone", async () => {
    const { game, defender, ally } = await navalGame();
    const b = defender.buildUnit(
      UnitType.CoastalBattery,
      game.ref(SHORE_X, 8),
      {},
    );
    const w = warship(game, ally, game.ref(12, 8));
    game.addExecution(new WarshipExecution(w));
    executeTicks(game, 200);
    expect(b.health()).toBe(b.maxHealth());
  });

  test("a battery and a warship trade shells", async () => {
    const { game, defender, attacker } = await navalGame();
    const b = battery(game, defender);
    const w = warship(game, attacker, game.ref(12, 8));
    game.addExecution(new WarshipExecution(w));
    executeTicks(game, 100);
    expect(b.health()).toBeLessThan(b.maxHealth());
    expect(w.health()).toBeLessThan(w.maxHealth());
  });

  test("a battery is captured with its tile", async () => {
    const { game, defender, attacker } = await navalGame();
    const b = battery(game, defender);
    game.addExecution(new PlayerExecution(defender));
    executeTicks(game, 1);
    attacker.conquer(b.tile());
    executeTicks(game, 2);
    expect(b.isActive()).toBe(true);
    expect(b.owner()).toBe(attacker);
  });
});
