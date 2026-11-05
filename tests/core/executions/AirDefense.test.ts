import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  FLAK_GUN_HIT_PERCENT,
  FLAK_GUN_RELOAD_TICKS,
  FLAK_ROUNDS,
} from "@openfront/engine-lib/game/ConventionalWar";
import { DroneExecution } from "@openfront/engine/execution/DroneExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  order,
  runUntil,
  structure,
} from "../../util/ConventionalWar";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 plains. a holds x < 100, b holds the rest.
async function twoSides(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
    infiniteGold: true,
  });
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 100, 200);
  conquerRect(game, b, 100, 0, 200, 200);
  return { game, a, b };
}

const FLIGHTS = [
  UnitType.Airstrike,
  UnitType.Airdrop,
  UnitType.CruiseMissile,
] as const;

function inFlight(game: Game): number {
  return FLIGHTS.reduce((n, t) => n + game.units(t).length, 0);
}

/** Takes off, then ticks until every flight has landed or been shot down. */
function flyAll(game: Game): void {
  executeTicks(game, 3);
  expect(inFlight(game)).toBeGreaterThan(0);
  runUntil(game, () => inFlight(game) === 0, 200);
}

/**
 * Fires `count` cruise missiles in one tick at `sam`, from `count` silos
 * lined up on a's side.
 */
function cruiseVolley(game: Game, a: Player, sam: Unit, count: number): void {
  for (let i = 0; i < count; i++) {
    structure(game, a, UnitType.MissileSilo, game.ref(20, 40 + i * 20));
  }
  for (let i = 0; i < count; i++) {
    order(game, a, UnitType.CruiseMissile, sam.tile());
  }
  flyAll(game);
}

describe("SAMs against planes and cruise missiles", () => {
  test("a loaded SAM shoots down an airstrike, as it would a nuke", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 110));
    const post = structure(game, b, UnitType.DefensePost, game.ref(150, 100));
    order(game, a, UnitType.Airstrike, post.tile());
    flyAll(game);
    expect(post.isActive()).toBe(true);
    // It cost the SAM its missile.
    expect(sam.isInCooldown()).toBe(true);
  });

  test("a single cruise missile against a loaded level-1 SAM is intercepted", async () => {
    const { game, a, b } = await twoSides();
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 100));
    cruiseVolley(game, a, sam, 1);
    expect(sam.isActive()).toBe(true);
    expect(sam.isInCooldown()).toBe(true);
  });

  test("a level-1 SAM needs exactly 2 cruise missiles", async () => {
    const { game, a, b } = await twoSides();
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 100));
    cruiseVolley(game, a, sam, 2);
    expect(sam.isActive()).toBe(false);
  });

  test("a level-3 SAM survives a volley of 3 and dies to 4", async () => {
    for (const [volley, survives] of [
      [3, true],
      [4, false],
    ] as const) {
      const { game, a, b } = await twoSides();
      const sam = structure(
        game,
        b,
        UnitType.SAMLauncher,
        game.ref(150, 100),
        3,
      );
      // Let the upgrade's range growth finish.
      executeTicks(game, 60);
      cruiseVolley(game, a, sam, volley);
      expect(sam.isActive(), `volley of ${volley}`).toBe(survives);
    }
  });

  test("a SAM with every missile reloading lets an airdrop through", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 104));
    sam.launch();
    a.setTroops(200_000);
    const target = game.ref(150, 100);
    order(game, a, UnitType.Airdrop, target, { troops: 20_000 });
    flyAll(game);
    expect(game.owner(target).id()).toBe(a.id());
    // A loaded SAM shoots the next one down; its troops are lost.
    executeTicks(game, 300);
    const other = game.ref(160, 100);
    order(game, a, UnitType.Airdrop, other, { troops: 20_000 });
    flyAll(game);
    expect(game.owner(other).id()).toBe(b.id());
  });

  test("SAMs ignore drones", async () => {
    const { game, a, b } = await twoSides();
    const sam = structure(game, b, UnitType.SAMLauncher, game.ref(150, 100));
    const drone = a.buildUnit(UnitType.Drone, game.ref(140, 100), {
      targetUnit: sam,
    });
    executeTicks(game, 20);
    expect(drone.isActive()).toBe(true);
    expect(sam.isInCooldown()).toBe(false);
    expect(game.units(UnitType.SAMMissile)).toHaveLength(0);
  });
});

describe("flak guns", () => {
  test(`each round downs a plane ${FLAK_GUN_HIT_PERCENT}% of the time (seeded)`, async () => {
    const { game, a, b } = await twoSides();
    const gun = structure(game, b, UnitType.FlakGun, game.ref(150, 100));
    // A plane parked in range (no execution flies it): the gun fires at it
    // whenever a round is loaded until it falls, then at the next one.
    const park = () =>
      a.buildUnit(UnitType.Airstrike, game.ref(145, 100), {
        targetTile: game.ref(145, 100),
        trajectory: [game.ref(145, 100)],
      });
    let plane = park();
    let shots = 0;
    let hits = 0;
    let lastShot: number | undefined;
    while (shots < 400) {
      executeTicks(game, 1);
      const fired = gun.missileTimerQueue().slice(-1)[0];
      if (fired !== undefined && fired !== lastShot) {
        shots++;
        lastShot = fired;
      }
      if (!plane.isActive()) {
        hits++;
        plane = park();
      }
    }
    const rate = hits / shots;
    expect(rate).toBeGreaterThan(FLAK_GUN_HIT_PERCENT / 100 - 0.07);
    expect(rate).toBeLessThan(FLAK_GUN_HIT_PERCENT / 100 + 0.07);
  });

  test(`${FLAK_ROUNDS} quick rounds, then it must wait for a reload`, async () => {
    const { game, a, b } = await twoSides();
    const gun = structure(game, b, UnitType.FlakGun, game.ref(150, 100));
    // Plenty of targets, so a hit never leaves it without one.
    for (let i = 0; i < 12; i++) {
      a.buildUnit(UnitType.Airstrike, game.ref(140, 90 + i), {
        targetTile: game.ref(140, 90 + i),
        trajectory: [game.ref(140, 90 + i)],
      });
    }
    runUntil(game, () => gun.missileTimerQueue().length > 0, 5);
    expect(gun.missileTimerQueue()).toHaveLength(1);
    executeTicks(game, 1);
    expect(gun.missileTimerQueue()).toHaveLength(FLAK_ROUNDS);
    const [first, second] = gun.missileTimerQueue();
    expect(second).toBe(first + 1);
    // Both rounds reloading: no shot until the first is back.
    executeTicks(game, FLAK_GUN_RELOAD_TICKS - 3);
    expect(gun.missileTimerQueue()).toEqual([first, second]);
    // The first round is back 30 ticks after it fired, and fires at once.
    runUntil(game, () => gun.missileTimerQueue()[0] !== first, 5);
    expect(gun.missileTimerQueue()).toEqual([
      second,
      first + FLAK_GUN_RELOAD_TICKS,
    ]);
  });

  test("a swarm bigger than its rounds gets through", async () => {
    const { game, a, b } = await twoSides();
    const gun = structure(game, b, UnitType.FlakGun, game.ref(150, 100));
    for (let i = 0; i < FLAK_ROUNDS + 1; i++) {
      const drone = a.buildUnit(UnitType.Drone, game.ref(140, 98 + i * 2), {
        targetUnit: gun,
      });
      game.addExecution(new DroneExecution(drone));
    }
    runUntil(game, () => game.units(UnitType.Drone).length === 0, 50);
    expect(gun.isActive()).toBe(false);
  });

  test("several guns layer up against a plane", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(70, 100));
    for (const y of [80, 95, 110, 125]) {
      structure(game, b, UnitType.FlakGun, game.ref(130, y));
    }
    let downed = 0;
    for (let i = 0; i < 6; i++) {
      order(game, a, UnitType.Airstrike, game.ref(160, 100));
      executeTicks(game, 3);
      const plane = game.units(UnitType.Airstrike)[0];
      runUntil(game, () => !plane.isActive(), 100);
      if (!plane.reachedTarget()) downed++;
      executeTicks(game, 260); // the sortie recharges
    }
    expect(downed).toBeGreaterThan(0);
  });

  test("never engages cruise missiles", async () => {
    const { game, a, b } = await twoSides();
    structure(game, b, UnitType.FlakGun, game.ref(150, 100));
    const missile = a.buildUnit(UnitType.CruiseMissile, game.ref(145, 100), {
      targetTile: game.ref(145, 100),
      trajectory: [game.ref(145, 100)],
    });
    executeTicks(game, FLAK_GUN_RELOAD_TICKS * 10);
    expect(missile.isActive()).toBe(true);
  });
});
