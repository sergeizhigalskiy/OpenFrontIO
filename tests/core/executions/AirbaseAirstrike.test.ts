import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  AIRBASE_SORTIE_RECHARGE_TICKS,
  AIRBASE_STRIKE_RANGE,
  AIRDROP_MAX_TROOPS_PERCENT,
  AIRSTRIKE_MAX_FRONT_KILL,
  AIRSTRIKE_MAX_TROOP_KILL,
  AIRSTRIKE_STRUCTURE_RADIUS,
  airdropTroops,
  airstrikeFrontKills,
  airstrikeTroopKills,
} from "@openfront/engine-lib/game/ConventionalWar";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { PlayerExecution } from "@openfront/engine/execution/PlayerExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import {
  conquerRect,
  conventionalGame,
  order,
  runUntil,
  structure,
} from "../../util/ConventionalWar";
import { executeTicks } from "../../util/utils";

// big_plains: 200x200 plains. a holds the west, b the east.
async function twoSides(): Promise<{ game: Game; a: Player; b: Player }> {
  const { game, players } = await conventionalGame("big_plains", ["a", "b"], {
    infiniteGold: true,
  });
  const [a, b] = players;
  conquerRect(game, a, 0, 0, 100, 200);
  conquerRect(game, b, 100, 0, 200, 200);
  return { game, a, b };
}

/** Takes off, then ticks until no airstrike or airdrop plane is in the air. */
function landAll(game: Game): void {
  executeTicks(game, 3);
  expect(
    game.units(UnitType.Airstrike).length + game.units(UnitType.Airdrop).length,
  ).toBeGreaterThan(0);
  runUntil(
    game,
    () =>
      game.units(UnitType.Airstrike).length === 0 &&
      game.units(UnitType.Airdrop).length === 0,
    200,
  );
}

describe("airbase sorties", () => {
  test("one sortie, recharged after 250 ticks, range 150", async () => {
    const { game, a } = await twoSides();
    const base = structure(game, a, UnitType.Airbase, game.ref(20, 100));
    const target = game.ref(130, 100);
    expect(a.canBuild(UnitType.Airstrike, target)).toBe(base.tile());
    // Out of range: more than 150 tiles away.
    expect(
      a.canBuild(
        UnitType.Airstrike,
        game.ref(20 + AIRBASE_STRIKE_RANGE + 5, 100),
      ),
    ).toBe(false);

    order(game, a, UnitType.Airstrike, target);
    executeTicks(game, 3);
    expect(base.isInCooldown()).toBe(true);
    // The sortie is spent: neither an airstrike nor an airdrop can go.
    expect(a.canBuild(UnitType.Airstrike, target)).toBe(false);
    expect(a.canBuild(UnitType.Airdrop, target)).toBe(false);
    executeTicks(game, AIRBASE_SORTIE_RECHARGE_TICKS - 10);
    expect(base.isInCooldown()).toBe(true);
    executeTicks(game, 15);
    expect(base.isInCooldown()).toBe(false);
    expect(a.canBuild(UnitType.Airstrike, target)).toBe(base.tile());
  });

  test("captured with its tile like any structure", async () => {
    const { game, a, b } = await twoSides();
    game.addExecution(new PlayerExecution(a), new PlayerExecution(b));
    const base = structure(game, a, UnitType.Airbase, game.ref(99, 100));
    b.conquer(base.tile());
    executeTicks(game, 2);
    expect(base.owner().id()).toBe(b.id());
  });

  test("an airstrike needs an enemy tile", async () => {
    const { game, a } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    expect(a.canBuild(UnitType.Airstrike, game.ref(80, 100))).toBe(false);
  });
});

describe("airstrike effects", () => {
  test("troop kills: 4% capped at 40k, front 15% capped at 40k in total", () => {
    expect(airstrikeTroopKills(100_000)).toBe(4_000);
    expect(airstrikeTroopKills(5_000_000)).toBe(AIRSTRIKE_MAX_TROOP_KILL);
    expect(airstrikeFrontKills([100_000, 50_000])).toEqual([15_000, 7_500]);
    const capped = airstrikeFrontKills([200_000, 200_000, 200_000]);
    expect(capped.reduce((s, k) => s + k, 0)).toBe(AIRSTRIKE_MAX_FRONT_KILL);
  });

  test("destroys military structures within 2 tiles, spares economy and land", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    const target = game.ref(140, 100);
    const post = structure(game, b, UnitType.DefensePost, game.ref(141, 100));
    const sam = structure(
      game,
      b,
      UnitType.SAMLauncher,
      game.ref(140, 101 + 1),
    );
    // Out of the 2-tile radius (a 3-tile radius would have taken it).
    const flak = structure(
      game,
      b,
      UnitType.Airbase,
      game.ref(140 - (AIRSTRIKE_STRUCTURE_RADIUS + 1), 100),
    );
    const city = structure(game, b, UnitType.City, game.ref(139, 100));
    const port = b.buildUnit(UnitType.Factory, game.ref(140, 99), {});
    // SAMs shoot planes down: keep this SAM's tube spent.
    sam.launch();
    b.setTroops(500_000);
    const tilesBefore = b.numTilesOwned();
    order(game, a, UnitType.Airstrike, target);
    landAll(game);

    expect(post.isActive()).toBe(false);
    expect(sam.isActive()).toBe(false);
    expect(flak.isActive()).toBe(true);
    expect(city.isActive()).toBe(true);
    expect(port.isActive()).toBe(true);
    expect(b.numTilesOwned()).toBe(tilesBefore);
    expect(game.owner(target)).toBe(b);
    // 4% of 500k, plus troop regen in between.
    expect(b.troops()).toBeLessThan(500_000 - 20_000 + 5_000);
    expect(b.troops()).toBeGreaterThan(500_000 - 20_000 - 1);
  });

  test("destroys an enemy siege camp, a military structure", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    const camp = structure(game, b, UnitType.SiegeCamp, game.ref(140, 100));
    order(game, a, UnitType.Airstrike, camp.tile());
    landAll(game);
    expect(camp.isActive()).toBe(false);
  });

    test("15% of a nearby attack, never land", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(60, 100));
    b.setTroops(100_000);
    game.addExecution(new AttackExecution(60_000, b, a.id(), null));
    executeTicks(game, 2);
    const attack = b.outgoingAttacks()[0];
    // A b tile on the front line.
    const target = [...b.borderTiles()].find(
      (t) => game.x(t) === 100 && game.y(t) === 100,
    )!;
    expect(target).toBeDefined();
    const attackTroops = attack.troops();
    const owned = b.numTilesOwned();
    order(game, a, UnitType.Airstrike, target);
    executeTicks(game, 3);
    const flying = game.units(UnitType.Airstrike)[0];
    expect(flying).toBeDefined();
    runUntil(game, () => !flying.isActive(), 100);
    // The attack lost 15% of what it held at impact (it also fights a).
    expect(attack.troops()).toBeLessThan(attackTroops * 0.9);
    // b still holds what its attack holds; the strike took no land.
    expect(b.numTilesOwned()).toBeGreaterThanOrEqual(owned);
  });
});

describe("airdrop", () => {
  test("carries the attack share capped at 15% of max troops", async () => {
    expect(airdropTroops(50_000, 100_000, 1_000_000)).toBe(50_000);
    expect(airdropTroops(500_000, 1_000_000, 1_000_000)).toBe(
      (1_000_000 * AIRDROP_MAX_TROOPS_PERCENT) / 100,
    );
    expect(airdropTroops(500_000, 10_000, 1_000_000)).toBe(10_000);
  });

  test("lands on enemy land and attacks outward from it", async () => {
    const { game, a, b } = await twoSides();
    const base = structure(game, a, UnitType.Airbase, game.ref(90, 100));
    a.setTroops(200_000);
    const target = game.ref(160, 100);
    // Own land is no target.
    expect(a.canBuild(UnitType.Airdrop, game.ref(50, 100))).toBe(false);
    order(game, a, UnitType.Airdrop, target, { troops: 30_000 });
    executeTicks(game, 3);
    const plane = game.units(UnitType.Airdrop)[0];
    expect(plane.troops()).toBe(30_000);
    expect(a.troops()).toBeLessThanOrEqual(200_000 - 30_000 + 5_000);
    expect(base.isInCooldown()).toBe(true);
    runUntil(game, () => !plane.isActive(), 100);
    // The landing tile is a's and the paratroopers attack b from it.
    expect(game.owner(target).id()).toBe(a.id());
    const attack = a.outgoingAttacks().find((x) => x.sourceTile() === target);
    expect(attack).toBeDefined();
    expect(attack!.target()).toBe(b);
  });

  test("lands on unclaimed land too", async () => {
    const { game, players } = await conventionalGame("big_plains", ["a"], {
      infiniteGold: true,
    });
    const [a] = players;
    conquerRect(game, a, 0, 0, 30, 30);
    structure(game, a, UnitType.Airbase, game.ref(20, 20));
    a.setTroops(100_000);
    const target = game.ref(80, 80);
    order(game, a, UnitType.Airdrop, target, { troops: 10_000 });
    landAll(game);
    expect(game.owner(target).id()).toBe(a.id());
  });

  test("a plane shot down loses its troops", async () => {
    const { game, a, b } = await twoSides();
    structure(game, a, UnitType.Airbase, game.ref(90, 100));
    structure(game, b, UnitType.SAMLauncher, game.ref(150, 100));
    a.setTroops(200_000);
    const target = game.ref(160, 100);
    order(game, a, UnitType.Airdrop, target, { troops: 40_000 });
    landAll(game);
    expect(game.owner(target).id()).toBe(b.id());
    expect(a.outgoingAttacks().some((x) => x.sourceTile() === target)).toBe(
      false,
    );
  });
});
