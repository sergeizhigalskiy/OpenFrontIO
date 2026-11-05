import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  RISING_TIDE_FIRST_WAVE_TICKS,
  RISING_TIDE_WARNING_TICKS,
  risingTideWaveBudget,
  risingTideWaveTiles,
} from "@openfront/engine-lib/game/RisingTide";
import {
  tilesInRadius,
  VOLCANO_FIRST_RUMBLE_TICKS,
  VOLCANO_WARNING_RADIUS,
} from "@openfront/engine-lib/game/Volcanoes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import {
  highGroundFocusTile,
  isCataclysmHazard,
} from "@openfront/engine/execution/nation/NationCataclysm";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { NationStructurePlacement } from "@openfront/engine/execution/nation/NationStructurePlacement";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { RisingTideExecution } from "@openfront/engine/execution/RisingTideExecution";
import { VolcanoExecution } from "@openfront/engine/execution/VolcanoExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "../../util/Setup";

async function withNation(
  map: string,
  config = {},
): Promise<{ game: Game; nation: Player }> {
  const game = await setup(map, { instantBuild: true, ...config });
  game.addPlayer(new PlayerInfo("nation", PlayerType.Nation, null, "nation"));
  const nation = game.player("nation");
  nation.addGold(1_000_000_000n);
  return { game, nation };
}

function runTo(game: Game, tick: number): void {
  while (game.ticks() < tick) game.executeNextTick();
}

/** spawnTile from several seeds, so the sampled tiles differ. */
function placements(game: Game, nation: Player, type: UnitType) {
  const out: (TileRef | null)[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const placement = new NationStructurePlacement(
      new PseudoRandom(seed),
      game,
      nation,
    );
    placement.startRound();
    out.push(placement.spawnTile(type));
  }
  return out;
}

describe("nations and volcanoes", () => {
  test("no new structures inside a rumbling volcano's warning ring", async () => {
    const { game, nation } = await withNation("big_plains");
    const site = game.ref(100, 100);
    // All of the nation's land is inside the ring.
    for (const t of tilesInRadius(game.map(), site, VOLCANO_WARNING_RADIUS)) {
      nation.conquer(t);
    }
    game.addExecution(new VolcanoExecution("ai", [{ x: 100, y: 100 }]));
    runTo(game, VOLCANO_FIRST_RUMBLE_TICKS);
    expect(isCataclysmHazard(game, site)).toBe(false);
    expect(
      placements(game, nation, UnitType.City).some((t) => t !== null),
    ).toBe(true);

    game.executeNextTick(); // starts rumbling
    expect(isCataclysmHazard(game, site)).toBe(true);
    expect(isCataclysmHazard(game, game.ref(10, 10))).toBe(false);
    expect(placements(game, nation, UnitType.City)).toEqual(
      new Array(12).fill(null),
    );
  });
});

describe("nations and volcanoes: reactive builds", () => {
  test("a capital's or port's reactive build skips a warned spot too", async () => {
    // Hard reacts every time (Medium only on a coin flip).
    const { game, nation } = await withNation("big_plains", {
      difficulty: Difficulty.Hard,
    });
    const site = game.ref(100, 100);
    for (const t of tilesInRadius(game.map(), site, VOLCANO_WARNING_RADIUS)) {
      nation.conquer(t);
    }
    // buildNear is what the capital, port and front defenses build through.
    const buildNear = (behavior: NationStructureBehavior) =>
      (
        behavior as unknown as {
          buildNear(type: UnitType, center: TileRef, maxDist: number): boolean;
        }
      ).buildNear(UnitType.DefensePost, site, 10);
    const behavior = () =>
      new NationStructureBehavior(new PseudoRandom(3), game, nation);

    game.addExecution(new VolcanoExecution("ai", [{ x: 100, y: 100 }]));
    runTo(game, VOLCANO_FIRST_RUMBLE_TICKS);
    expect(buildNear(behavior())).toBe(true);
    game.executeNextTick(); // starts rumbling
    expect(isCataclysmHazard(game, site)).toBe(true);
    expect(buildNear(behavior())).toBe(false);
  });
});

describe("nations and the rising tide", () => {
  test("no new structures on the tiles the coming wave floods", async () => {
    const { game, nation } = await withNation("half_land_half_ocean");
    const tide = new RisingTideExecution();
    game.addExecution(tide);
    // The tiles the first wave will flood; the nation holds only those.
    const doomed = risingTideWaveTiles(
      game.map(),
      risingTideWaveBudget(game.numLandTiles(), game.numLandTiles()),
    );
    for (const t of doomed) nation.conquer(t);
    const warnAt = RISING_TIDE_FIRST_WAVE_TICKS - RISING_TIDE_WARNING_TICKS;
    runTo(game, warnAt);
    // Before the warning they are fine building land.
    expect(isCataclysmHazard(game, doomed[0])).toBe(false);
    expect(
      placements(game, nation, UnitType.City).some((t) => t !== null),
    ).toBe(true);

    game.executeNextTick(); // the warning goes up
    for (const t of doomed) {
      expect(tide.floodsNext(t)).toBe(true);
      expect(isCataclysmHazard(game, t)).toBe(true);
    }
    expect(placements(game, nation, UnitType.City)).toEqual(
      new Array(12).fill(null),
    );
  });

  test("expansions aim for the highest free land in reach", async () => {
    const off = await withNation("world");
    const on = await withNation("world", { risingTide: true });
    for (const { game, nation } of [off, on]) {
      for (let x = 1407; x < 1417; x++) {
        for (let y = 95; y < 105; y++) nation.conquer(game.ref(x, y));
      }
    }
    expect(highGroundFocusTile(off.game, off.nation)).toBeNull();

    const { game, nation } = on;
    const focus = highGroundFocusTile(game, nation)!;
    expect(focus).not.toBeNull();
    expect(game.hasOwner(focus)).toBe(false);
    // At least as high as any free tile on the border.
    for (const b of nation.borderTiles()) {
      for (const n of game.neighbors(b)) {
        if (game.isLand(n) && !game.hasOwner(n)) {
          expect(game.magnitude(focus)).toBeGreaterThanOrEqual(
            game.magnitude(n),
          );
        }
      }
    }

    // The nation's expansion into free land pushes toward it.
    nation.addTroops(100_000);
    const random = new PseudoRandom(7);
    const emoji = new NationEmojiBehavior(random, game, nation);
    const attack = new NationAttackBehavior(
      random,
      game,
      nation,
      0.5,
      0.5,
      0.2,
      new NationAllianceBehavior(random, game, nation, emoji),
      emoji,
      new NationWarshipBehavior(random, game, nation, emoji),
    );
    expect(attack.sendAttack(game.terraNullius(), true)).toBe(true);
    const exec = game
      .executions()
      .find((e): e is AttackExecution => e instanceof AttackExecution)!;
    expect((exec as unknown as { focusTile: TileRef | null }).focusTile).toBe(
      focus,
    );
  });

  test("no choice, no focus: flat land advances evenly", async () => {
    const { game, nation } = await withNation("half_land_half_ocean", {
      risingTide: true,
    });
    let first: TileRef | undefined;
    game.forEachTile((t) => {
      if (first === undefined && game.isLand(t)) first = t;
    });
    nation.conquer(first!);
    expect(highGroundFocusTile(game, nation)).toBeNull();
  });
});
