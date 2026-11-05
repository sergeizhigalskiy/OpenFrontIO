import {
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { AttackLogicInput } from "@openfront/engine-lib/game/AttackLogic";
import {
  coveringDefensePostLevel,
  DEFENSE_POST_MAX_LEVEL,
  DEFENSE_POST_MAX_RANGE,
  defensePostCoverage,
  defensePostRange,
  POST_COVERAGE_FULL,
  POST_COVERAGE_NONE,
} from "@openfront/engine-lib/game/Siege";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { ConstructionExecution } from "@openfront/engine/execution/ConstructionExecution";
import { DefensePostExecution } from "@openfront/engine/execution/DefensePostExecution";
import { UpgradeStructureExecution } from "@openfront/engine/execution/UpgradeStructureExecution";
import { Game, Player, Unit } from "@openfront/engine/game/Game";
import { vi } from "vitest";
import { setup } from "../../util/Setup";
import { UseRealAttackLogic } from "../../util/TestConfig";
import { executeTicks } from "../../util/utils";

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

// plains: 100x100, all Plains. The defender holds x >= 50.
async function plainsGame(config: Parameters<typeof setup>[1] = {}) {
  const game = await setup(
    "plains",
    { instantBuild: true, ...config },
    [
      new PlayerInfo("attacker", PlayerType.Human, null, "attacker"),
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("other", PlayerType.Human, null, "other"),
    ],
    undefined,
    UseRealAttackLogic,
  );
  const attacker = game.player("attacker");
  const defender = game.player("defender");
  const other = game.player("other");
  conquerRect(game, attacker, 0, 0, 50, 100);
  conquerRect(game, defender, 50, 0, 100, 100);
  return { game, attacker, defender, other };
}

function postAt(game: Game, owner: Player, x: number, y: number, level = 1) {
  const post = owner.buildUnit(UnitType.DefensePost, game.ref(x, y), {});
  for (let l = 1; l < level; l++) post.increaseLevel();
  return post;
}

function coverage(game: Game, defender: Player, x: number, y: number) {
  return defensePostCoverage(
    game,
    game,
    game.ref(x, y),
    defender.smallID(),
    [],
    0,
  );
}

describe("defense post ranges by level", () => {
  test("30, 38 and 45 tiles at levels 1 to 3", () => {
    expect(defensePostRange(1)).toBe(30);
    expect(defensePostRange(2)).toBe(38);
    expect(defensePostRange(3)).toBe(45);
    expect(DEFENSE_POST_MAX_LEVEL).toBe(3);
    expect(DEFENSE_POST_MAX_RANGE).toBe(defensePostRange(3));
    // Out-of-range levels clamp.
    expect(defensePostRange(0)).toBe(30);
    expect(defensePostRange(7)).toBe(45);
  });

  test("the config reports the same ranges and caps the level at 3", async () => {
    const { game } = await plainsGame();
    const config = game.config();
    expect(config.defensePostRange()).toBe(30);
    expect(config.defensePostRange(2)).toBe(38);
    expect(config.defensePostRange(3)).toBe(45);
    const info = config.unitInfo(UnitType.DefensePost);
    expect(info.upgradable).toBe(true);
    expect(info.maxLevel).toBe(3);
  });

  test("each post covers only its own level's range", async () => {
    const { game, defender } = await plainsGame();
    const post = postAt(game, defender, 90, 50);
    // 35 tiles away: level 2 and up.
    expect(coverage(game, defender, 55, 50)).toBe(POST_COVERAGE_NONE);
    post.increaseLevel();
    expect(coverage(game, defender, 55, 50)).toBe(POST_COVERAGE_FULL);
    // 44 tiles away: level 3 only.
    expect(coverage(game, defender, 46, 50)).toBe(POST_COVERAGE_NONE);
    post.increaseLevel();
    expect(coverage(game, defender, 46, 50)).toBe(POST_COVERAGE_FULL);
    // 46 tiles away: out of every level's reach.
    expect(coverage(game, defender, 44, 50)).toBe(POST_COVERAGE_NONE);
    expect(
      coveringDefensePostLevel(
        game,
        game,
        game.ref(55, 50),
        defender.smallID(),
      ),
    ).toBe(3);
  });

  test("the highest covering level is reported; others' and unbuilt posts don't count", async () => {
    const { game, defender, other } = await plainsGame();
    postAt(game, defender, 60, 50, 1);
    postAt(game, defender, 90, 50, 2);
    postAt(game, other, 62, 52, 3);
    const tile = game.ref(58, 50);
    expect(coveringDefensePostLevel(game, game, tile, defender.smallID())).toBe(
      2,
    );
    const building = postAt(game, defender, 59, 60, 3);
    building.setUnderConstruction(true);
    expect(coveringDefensePostLevel(game, game, tile, defender.smallID())).toBe(
      2,
    );
    expect(coveringDefensePostLevel(game, game, tile, other.smallID())).toBe(3);
  });

  test("level-1 coverage is the old 30-tile check on every tile", async () => {
    // big_plains is 200x200, four unit-grid cells: posts on and near the
    // cell edges at x = 100 and y = 100.
    const game = await setup("big_plains", { instantBuild: true }, [
      new PlayerInfo("defender", PlayerType.Human, null, "defender"),
      new PlayerInfo("other", PlayerType.Human, null, "other"),
    ]);
    const defender = game.player("defender");
    const other = game.player("other");
    for (const [x, y] of [
      [100, 50],
      [130, 100],
      [99, 160],
      [40, 40],
    ]) {
      postAt(game, defender, x, y);
    }
    postAt(game, other, 160, 160);
    for (let x = 0; x < 200; x++) {
      for (let y = 0; y < 200; y++) {
        const old = game.hasUnitNearby(
          game.ref(x, y),
          30,
          UnitType.DefensePost,
          defender.id(),
        );
        expect(coverage(game, defender, x, y) !== POST_COVERAGE_NONE).toBe(old);
      }
    }
    // The old query never found a post exactly 30 tiles away along +x when
    // it starts the next grid cell; the level filter keeps that.
    expect(coverage(game, defender, 70, 50)).toBe(POST_COVERAGE_NONE);
    expect(coverage(game, defender, 71, 50)).toBe(POST_COVERAGE_FULL);
  });
});

describe("defense post upgrades", () => {
  test("upgrade through the structure-upgrade system, priced like a new post, to level 3", async () => {
    const { game, defender } = await plainsGame();
    defender.addGold(1_000_000n);
    game.addExecution(
      new ConstructionExecution(
        defender,
        UnitType.DefensePost,
        game.ref(80, 50),
      ),
    );
    executeTicks(game, 2);
    const [post] = defender.units(UnitType.DefensePost);
    expect(post.level()).toBe(1);
    const gold = defender.gold();
    const cost = game.unitInfo(UnitType.DefensePost).cost;
    // The next level costs what the next post would: the 2nd, then the 3rd.
    const expected = cost(game, defender) + cost(game, defender, 1);
    expect(expected).toBe(100_000n + 150_000n);

    // Asked for five levels, it stops at the cap.
    game.addExecution(new UpgradeStructureExecution(defender, post.id(), 5));
    executeTicks(game, 1);
    expect(post.level()).toBe(3);
    expect(gold - defender.gold()).toBe(expected);
    expect(defender.canUpgradeUnit(post)).toBe(false);

    game.addExecution(new UpgradeStructureExecution(defender, post.id(), 1));
    executeTicks(game, 1);
    expect(post.level()).toBe(3);
    expect(gold - defender.gold()).toBe(expected);
  });

  test("the build menu prices only the levels left", async () => {
    const { game, defender } = await plainsGame();
    defender.addGold(10_000_000n);
    const post = postAt(game, defender, 80, 50);
    const offer = () =>
      defender
        .buildableUnits(game.ref(80, 50), [UnitType.DefensePost])
        .find((u) => u.type === UnitType.DefensePost)!;
    expect(offer().canUpgrade).toBe(post.id());
    expect(offer().upgradeCosts).toEqual([100_000n, 250_000n]);
    defender.upgradeUnit(post);
    expect(offer().upgradeCosts).toEqual([150_000n]);
    defender.upgradeUnit(post);
    expect(offer().canUpgrade).toBe(false);
    expect(offer().upgradeCosts).toBeUndefined();
  });
});

describe("defense post range in combat", () => {
  /** The attackLogic inputs of the attacker's first ticks into the defender. */
  function attackInputs(game: Game, attacker: Player, defender: Player) {
    const inputs: AttackLogicInput[] = [];
    const config = game.config();
    const original = config.attackLogic.bind(config);
    const spy = vi.spyOn(config, "attackLogic").mockImplementation((input) => {
      inputs.push(input);
      return original(input);
    });
    attacker.setTroops(200_000);
    defender.setTroops(100_000);
    game.addExecution(new AttackExecution(50_000, attacker, defender.id()));
    executeTicks(game, 3);
    spy.mockRestore();
    return inputs;
  }

  test("a level-3 post 44 tiles behind the front defends it; a level-1 post doesn't", async () => {
    for (const level of [1, 3]) {
      const { game, attacker, defender } = await plainsGame();
      // 44 tiles from the front column (x = 50) at y = 50.
      postAt(game, defender, 94, 50, level);
      const inputs = attackInputs(game, attacker, defender);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.some((i) => i.defenderHasDefensePost)).toBe(level === 3);
      expect(inputs.every((i) => !i.siegeCampReducesDefensePost)).toBe(true);
    }
  });

  test("the post shells hostile convoys within its level's range", async () => {
    const { game, attacker, defender } = await plainsGame();
    const post = postAt(game, defender, 85, 50);
    const exec = new DefensePostExecution(post);
    exec.init(game, game.ticks());
    // 35 tiles from the post.
    const convoy: Unit = attacker.buildUnit(UnitType.Convoy, game.ref(50, 50), {
      troops: 1_000,
      targetTile: game.ref(10, 10),
      targetPlayer: attacker,
    });
    const target = () =>
      (
        exec as unknown as { findConvoyTarget(): Unit | null }
      ).findConvoyTarget();
    expect(target()).toBeNull();
    post.increaseLevel();
    expect(target()).toBe(convoy);
  });
});
