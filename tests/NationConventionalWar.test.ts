import {
  Difficulty,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  DRONE_COST,
  FLAK_ROUNDS,
} from "@openfront/engine-lib/game/ConventionalWar";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { AirMissionExecution } from "@openfront/engine/execution/AirMissionExecution";
import { AttackExecution } from "@openfront/engine/execution/AttackExecution";
import { DroneSwarmExecution } from "@openfront/engine/execution/DroneExecution";
import {
  cruiseVolleySize,
  droneSwarmSize,
} from "@openfront/engine/execution/nation/NationAirPlanning";
import { NationAllianceBehavior } from "@openfront/engine/execution/nation/NationAllianceBehavior";
import { NationAttackBehavior } from "@openfront/engine/execution/nation/NationAttackBehavior";
import { NationEmojiBehavior } from "@openfront/engine/execution/nation/NationEmojiBehavior";
import { NationMIRVBehavior } from "@openfront/engine/execution/nation/NationMIRVBehavior";
import { NationNukeBehavior } from "@openfront/engine/execution/nation/NationNukeBehavior";
import { NationStructureBehavior } from "@openfront/engine/execution/nation/NationStructureBehavior";
import { NationWarshipBehavior } from "@openfront/engine/execution/nation/NationWarshipBehavior";
import { Execution, Game, Player } from "@openfront/engine/game/Game";
import { conquerRect, setGold, structure } from "./util/ConventionalWar";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

// big_plains: the nation holds x < 100 with its capital at (50, 100), the
// human enemy x >= 100 with its capital at (150, 100).
async function war(
  difficulty: Difficulty,
  config: Partial<GameConfig> = {},
): Promise<{ game: Game; nation: Player; enemy: Player }> {
  const game = await setup(
    "big_plains",
    { conventionalWar: true, instantBuild: true, difficulty, ...config },
    [new PlayerInfo("enemy", PlayerType.Human, "c_enemy", "enemy")],
  );
  const nation = game.addPlayer(
    new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
  );
  const enemy = game.player("enemy");
  conquerRect(game, nation, 0, 0, 100, 200);
  conquerRect(game, enemy, 100, 0, 200, 200);
  nation.setSpawnTile(game.ref(50, 100));
  enemy.setSpawnTile(game.ref(150, 100));
  return { game, nation, enemy };
}

function behaviors(game: Game, nation: Player, seed = 1) {
  const random = new PseudoRandom(seed);
  const emoji = new NationEmojiBehavior(random, game, nation);
  const alliance = new NationAllianceBehavior(random, game, nation, emoji);
  const warship = new NationWarshipBehavior(random, game, nation, emoji);
  const attack = new NationAttackBehavior(
    random,
    game,
    nation,
    0.5,
    0.3,
    0.2,
    alliance,
    emoji,
    warship,
  );
  return {
    attack,
    warship,
    nuke: new NationNukeBehavior(random, game, nation, attack, emoji),
    mirv: new NationMIRVBehavior(random, game, nation, emoji),
    structure: new NationStructureBehavior(random, game, nation),
  };
}

/** Records the executions added from now on. */
function added(game: Game): Execution[] {
  const out: Execution[] = [];
  const original = game.addExecution.bind(game);
  vi.spyOn(game, "addExecution").mockImplementation((...execs) => {
    out.push(...execs);
    original(...execs);
  });
  return out;
}

function missions(execs: Execution[], type: UnitType): AirMissionExecution[] {
  return execs.filter(
    (e): e is AirMissionExecution =>
      e instanceof AirMissionExecution &&
      (e as unknown as { type: UnitType }).type === type,
  );
}

/** A land attack on `enemy`, with its front at x 100, and an enemy post covering it. */
async function frontWithPost(difficulty: Difficulty) {
  const { game, nation, enemy } = await war(difficulty);
  structure(game, nation, UnitType.Airbase, game.ref(80, 100));
  const post = structure(game, enemy, UnitType.DefensePost, game.ref(110, 100));
  nation.setTroops(1_000_000);
  enemy.setTroops(10_000);
  game.addExecution(new AttackExecution(200_000, nation, enemy.id(), null));
  executeTicks(game, 2);
  setGold(nation, 100_000_000n);
  return { game, nation, enemy, post };
}

describe("nation air support in conventional war", () => {
  test("a SAM covering the target gets a cruise volley of SAM level + 1, never a lone missile", async () => {
    const { game, nation, enemy } = await frontWithPost(Difficulty.Hard);
    structure(game, nation, UnitType.MissileSilo, game.ref(20, 100), 3);
    structure(game, nation, UnitType.MissileSilo, game.ref(20, 60), 2);
    const sam = structure(
      game,
      enemy,
      UnitType.SAMLauncher,
      game.ref(130, 100),
      3,
    );
    expect(cruiseVolleySize(game, nation, sam.tile())).toBe(sam.level() + 1);
    const execs = added(game);
    behaviors(game, nation).attack.maybeSupportFromTheAir();
    const volley = missions(execs, UnitType.CruiseMissile);
    expect(volley).toHaveLength(sam.level() + 1);
    expect(missions(execs, UnitType.Airstrike)).toHaveLength(0);
    for (const m of volley) {
      expect((m as unknown as { dst: number }).dst).toBe(sam.tile());
    }
    executeTicks(game, 2);
    expect(game.units(UnitType.CruiseMissile)).toHaveLength(4);
  });

  test("too few loaded tubes for the volley: nothing is fired", async () => {
    const { game, nation, enemy } = await frontWithPost(Difficulty.Hard);
    // 3 tubes against a level-3 SAM, which needs 4.
    structure(game, nation, UnitType.MissileSilo, game.ref(20, 100), 3);
    structure(game, enemy, UnitType.SAMLauncher, game.ref(130, 100), 3);
    const execs = added(game);
    behaviors(game, nation).attack.maybeSupportFromTheAir();
    expect(missions(execs, UnitType.CruiseMissile)).toHaveLength(0);
    expect(missions(execs, UnitType.Airstrike)).toHaveLength(0);
  });

  test("flak covering the target gets a drone swarm at the gun, one more than its loaded rounds", async () => {
    const { game, nation, enemy } = await frontWithPost(Difficulty.Hard);
    const gun = structure(game, enemy, UnitType.FlakGun, game.ref(115, 100));
    structure(game, enemy, UnitType.FlakGun, game.ref(120, 110));
    const rounds = 2 * FLAK_ROUNDS;
    expect(droneSwarmSize(game, nation, gun)).toBe(rounds + 1);
    const execs = added(game);
    behaviors(game, nation).attack.maybeSupportFromTheAir();
    const swarms = execs.filter((e) => e instanceof DroneSwarmExecution);
    expect(swarms).toHaveLength(1);
    expect((swarms[0] as unknown as { remaining: number }).remaining).toBe(
      rounds + 1,
    );
    expect((swarms[0] as unknown as { tile: number }).tile).toBe(gun.tile());
    expect(missions(execs, UnitType.Airstrike)).toHaveLength(0);
  });

  test("an enemy siege camp on the front gets an airstrike, like a post", async () => {
    const { game, nation, enemy } = await war(Difficulty.Hard);
    structure(game, nation, UnitType.Airbase, game.ref(80, 100));
    const camp = structure(game, enemy, UnitType.SiegeCamp, game.ref(110, 100));
    nation.setTroops(1_000_000);
    enemy.setTroops(10_000);
    game.addExecution(new AttackExecution(200_000, nation, enemy.id(), null));
    executeTicks(game, 2);
    setGold(nation, 100_000_000n);
    const execs = added(game);
    behaviors(game, nation).attack.maybeSupportFromTheAir();
    const strikes = missions(execs, UnitType.Airstrike);
    expect(strikes).toHaveLength(1);
    expect((strikes[0] as unknown as { dst: number }).dst).toBe(camp.tile());
    executeTicks(game, 40);
    expect(camp.isActive()).toBe(false);
  });

  test("an open target gets an airstrike, paid like a human's", async () => {
    const { game, nation, post } = await frontWithPost(Difficulty.Hard);
    const execs = added(game);
    behaviors(game, nation).attack.maybeSupportFromTheAir();
    expect(missions(execs, UnitType.Airstrike)).toHaveLength(1);
    const before = nation.gold();
    executeTicks(game, 2);
    expect(nation.gold()).toBeLessThan(before);
    executeTicks(game, 40);
    expect(post.isActive()).toBe(false);
  });

  test("drone swarms go at a hostile warship off our port, sized past its guns", async () => {
    const game = await setup(
      "half_land_half_ocean",
      {
        conventionalWar: true,
        instantBuild: true,
        difficulty: Difficulty.Impossible,
      },
      [new PlayerInfo("enemy", PlayerType.Human, "c_enemy", "enemy")],
    );
    const nation = game.addPlayer(
      new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
    );
    const enemy = game.player("enemy");
    conquerRect(game, nation, 0, 0, 8, 16);
    // No airbase: drones take off from the nation's land.
    structure(game, nation, UnitType.Port, game.ref(7, 8));
    const ship = enemy.buildUnit(UnitType.Warship, game.ref(12, 8), {
      patrolTile: game.ref(12, 8),
    });
    setGold(nation, 10_000_000n);
    const execs = added(game);
    expect(behaviors(game, nation).warship.maybeSendDronesAtWarships()).toBe(
      true,
    );
    const swarm = execs.find((e) => e instanceof DroneSwarmExecution);
    // Three hits sink it, one more for its guns.
    expect((swarm as unknown as { remaining: number }).remaining).toBe(4);
    expect(droneSwarmSize(game, nation, ship)).toBe(4);
    expect(4n * BigInt(DRONE_COST)).toBeLessThan(nation.gold());
  });
});

describe("nation capitals in conventional war", () => {
  test("a lost capital comes first: an attack on its holder, spearheaded at the tile", async () => {
    for (const difficulty of [Difficulty.Hard, Difficulty.Medium]) {
      const { game, nation, enemy } = await war(difficulty);
      const capital = nation.capitalTile()!;
      enemy.conquer(capital);
      nation.setTroops(1_000_000);
      enemy.setTroops(10_000);
      const execs = added(game);
      behaviors(game, nation).attack.maybeAttack();
      const attacks = execs.filter((e) => e instanceof AttackExecution);
      expect(attacks.length, difficulty).toBeGreaterThan(0);
      const first = attacks[0] as unknown as {
        _targetID: string;
        focusTile: number | null;
      };
      expect(first._targetID).toBe(enemy.id());
      expect(first.focusTile).toBe(capital);
    }
  });

  test("Medium and up spearhead attacks at a nearby enemy capital; Easy doesn't", async () => {
    const focusOf = async (difficulty: Difficulty) => {
      const { game, nation, enemy } = await war(difficulty);
      // The enemy's capital close to our border.
      enemy.setSpawnTile(game.ref(110, 100));
      nation.setTroops(1_000_000);
      enemy.setTroops(10_000);
      const execs = added(game);
      const { attack } = behaviors(game, nation);
      for (let i = 0; i < 20; i++) attack.maybeAttack();
      const attack0 = execs.find((e) => e instanceof AttackExecution) as
        | { focusTile: number | null }
        | undefined;
      return { focus: attack0?.focusTile ?? null, tile: game.ref(110, 100) };
    };
    const hard = await focusOf(Difficulty.Impossible);
    expect(hard.focus).toBe(hard.tile);
    const easy = await focusOf(Difficulty.Easy);
    expect(easy.focus).toBeNull();
  });

  test("nations fortify a threatened capital and cover it from the air", async () => {
    const { game, nation, enemy } = await war(Difficulty.Impossible);
    // Enemy land within reach of the capital, an enemy airbase and silo too.
    conquerRect(game, enemy, 60, 95, 70, 105);
    structure(game, enemy, UnitType.Airbase, game.ref(150, 100));
    structure(game, enemy, UnitType.MissileSilo, game.ref(160, 100));
    // One structure so the reactive defenses are allowed.
    structure(game, nation, UnitType.City, game.ref(10, 10));
    setGold(nation, 100_000_000n);
    const { structure: build } = behaviors(game, nation);
    (build as unknown as { placementsCount: number }).placementsCount = 1;
    for (let i = 0; i < 8; i++) {
      build.handleStructures();
      executeTicks(game, 3);
    }
    const near = (type: UnitType, range: number) =>
      nation
        .units(type)
        .filter(
          (u) =>
            game.euclideanDistSquared(u.tile(), nation.capitalTile()!) <=
            range * range,
        ).length;
    expect(near(UnitType.DefensePost, 30)).toBeGreaterThan(0);
    expect(near(UnitType.FlakGun, 40)).toBeGreaterThan(0);
    expect(near(UnitType.SAMLauncher, 30)).toBeGreaterThan(0);
  });
});

describe("nation structures in conventional war, by difficulty", () => {
  async function buildOut(difficulty: Difficulty) {
    const { game, nation } = await war(difficulty);
    for (let i = 0; i < 8; i++) {
      structure(game, nation, UnitType.City, game.ref(10 + i * 10, 20));
    }
    setGold(nation, 200_000_000n);
    const { structure: build } = behaviors(game, nation);
    // A few ticks between calls, as in a game, so each build lands first.
    for (let i = 0; i < 25; i++) {
      build.handleStructures();
      executeTicks(game, 3);
    }
    return {
      airbases: nation.units(UnitType.Airbase).length,
      flak: nation.units(UnitType.FlakGun).length,
      sams: nation.units(UnitType.SAMLauncher).length,
      silos: nation.units(UnitType.MissileSilo).length,
    };
  }

  test("airbases and flak guns join the build order, SAMs and silos too; Impossible builds more than Easy", async () => {
    const easy = await buildOut(Difficulty.Easy);
    const impossible = await buildOut(Difficulty.Impossible);
    expect(easy.airbases).toBe(1);
    expect(impossible.airbases).toBeGreaterThan(easy.airbases);
    expect(impossible.flak).toBeGreaterThan(easy.flak);
    expect(impossible.sams).toBeGreaterThan(0);
    expect(impossible.silos).toBeGreaterThan(0);
  });
});

describe("nation coastal batteries", () => {
  test("Hard puts one by a port a hostile warship threatens, in normal games too; Easy doesn't", async () => {
    const batteries = async (
      difficulty: Difficulty,
      conventionalWar = true,
    ) => {
      const game = await setup(
        "world",
        { conventionalWar, instantBuild: true, difficulty },
        [new PlayerInfo("enemy", PlayerType.Human, "c_enemy", "enemy")],
      );
      const nation = game.addPlayer(
        new PlayerInfo("nation", PlayerType.Nation, null, "nation"),
      );
      const enemy = game.player("enemy");
      // The first west-facing coast on row 500, held by the nation.
      const y = 500;
      let x = 1;
      while (
        !(game.isLand(game.ref(x, y)) && game.isOcean(game.ref(x - 1, y)))
      ) {
        x++;
      }
      conquerRect(game, nation, x, y - 40, x + 60, y + 40);
      structure(game, nation, UnitType.City, game.ref(x + 40, y));
      const port = structure(game, nation, UnitType.Port, game.ref(x, y));
      const sea = game.ref(x - 20, y);
      expect(game.isOcean(sea)).toBe(true);
      enemy.buildUnit(UnitType.Warship, sea, { patrolTile: sea });
      setGold(nation, 50_000_000n);
      const { structure: build } = behaviors(game, nation);
      (build as unknown as { placementsCount: number }).placementsCount = 1;
      for (let i = 0; i < 4; i++) {
        build.handleStructures();
        executeTicks(game, 3);
      }
      return nation
        .units(UnitType.CoastalBattery)
        .filter(
          (b) => game.euclideanDistSquared(b.tile(), port.tile()) <= 30 * 30,
        ).length;
    };
    expect(await batteries(Difficulty.Easy)).toBe(0);
    expect(await batteries(Difficulty.Hard)).toBe(1);
    expect(await batteries(Difficulty.Hard, false)).toBe(1);
    expect(await batteries(Difficulty.Easy, false)).toBe(0);
  }, 120_000);
});

describe("nation heavy missiles in conventional war", () => {
  async function arsenal(difficulty: Difficulty) {
    const { game, nation, enemy } = await war(difficulty);
    structure(game, nation, UnitType.MissileSilo, game.ref(20, 100), 3);
    structure(game, nation, UnitType.Airbase, game.ref(80, 100));
    for (const y of [60, 80, 100, 120, 140]) {
      structure(game, enemy, UnitType.City, game.ref(160, y), 2);
      structure(game, enemy, UnitType.DefensePost, game.ref(170, y));
    }
    setGold(nation, 200_000_000n);
    return { game, nation, enemy };
  }

  test("Easy never fires the expensive weapons; Impossible fires ballistic and cluster missiles", async () => {
    for (const difficulty of [Difficulty.Easy, Difficulty.Impossible]) {
      const { game, nation } = await arsenal(difficulty);
      const execs = added(game);
      const { nuke, mirv } = behaviors(game, nation);
      for (let i = 0; i < 20; i++) {
        nuke.maybeSendNuke();
        mirv.considerMIRV();
        executeTicks(game, 3);
      }
      const ballistic = missions(execs, UnitType.BallisticMissile).length;
      const cluster = missions(execs, UnitType.ClusterMissile).length;
      if (difficulty === Difficulty.Easy) {
        expect(ballistic + cluster).toBe(0);
      } else {
        expect(ballistic).toBeGreaterThan(0);
        expect(cluster).toBeGreaterThan(0);
      }
    }
  });

  test("a nation never fires a ballistic missile whose blast would hit its own structures or land", async () => {
    const { game, nation, enemy } = await arsenal(Difficulty.Impossible);
    // Our exclave sits among every enemy structure.
    conquerRect(game, nation, 163, 55, 167, 145);
    const own = structure(game, nation, UnitType.City, game.ref(165, 100));
    const execs = added(game);
    const { nuke } = behaviors(game, nation);
    for (let i = 0; i < 10; i++) nuke.maybeSendNuke();
    expect(missions(execs, UnitType.BallisticMissile)).toHaveLength(0);
    expect(own.isActive()).toBe(true);

    // With the exclave gone, it fires, clear of our land.
    own.delete(false);
    conquerRect(game, enemy, 163, 55, 167, 145);
    nuke.maybeSendNuke();
    const fired = missions(execs, UnitType.BallisticMissile);
    expect(fired).toHaveLength(1);
    const dst = (fired[0] as unknown as { dst: number }).dst;
    expect(game.x(dst)).toBeGreaterThanOrEqual(120);
  });
});
