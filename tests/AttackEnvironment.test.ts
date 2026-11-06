/**
 * One environment rule for forests, rivers, fords, winter and mud, shared by
 * attacks and the forecast: each factor's losses and time, and the caps that
 * keep them small next to a defense post. Upstream's terrain, post, fallout
 * and traitor factors sit outside the cap.
 */
import { PlayerType, TerrainType } from "@openfront/engine-api/game/GameTypes";
import { TerrainFeature } from "@openfront/engine-api/game/TerrainFeature";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  AttackEnvironment,
  ENVIRONMENT_LOSS_CAP,
  ENVIRONMENT_TIME_CAP,
  ENVIRONMENT_TIME_CAP_WITH_POST,
  environmentCost,
  withEnvironmentCost,
} from "@openfront/engine-lib/game/AttackEnvironment";
import { AttackLogicInput } from "@openfront/engine-lib/game/AttackLogic";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { describe, expect, test } from "vitest";

const FEATURES = [
  TerrainFeature.None,
  TerrainFeature.Forest,
  TerrainFeature.River,
  TerrainFeature.Ford,
];

function env(o: Partial<AttackEnvironment>): AttackEnvironment {
  return {
    feature: TerrainFeature.None,
    enemyLand: true,
    winterSnow: false,
    mud: false,
    defensePost: false,
    ...o,
  };
}

describe("the environment table", () => {
  test("each factor alone", () => {
    const cost = (o: Partial<AttackEnvironment>) => environmentCost(env(o));
    expect(cost({})).toEqual({ lossMultiplier: 1, timeMultiplier: 1 });
    // Forest: losses on owned land only, time on any land.
    expect(cost({ feature: TerrainFeature.Forest })).toEqual({
      lossMultiplier: 1.2,
      timeMultiplier: 1.2,
    });
    expect(cost({ feature: TerrainFeature.Forest, enemyLand: false })).toEqual({
      lossMultiplier: 1,
      timeMultiplier: 1.2,
    });
    // River: any land.
    for (const enemyLand of [true, false]) {
      expect(cost({ feature: TerrainFeature.River, enemyLand })).toEqual({
        lossMultiplier: 1.25,
        timeMultiplier: 2,
      });
    }
    expect(cost({ feature: TerrainFeature.Ford })).toEqual({
      lossMultiplier: 1,
      timeMultiplier: 1,
    });
    // Winter: time only, any land.
    for (const enemyLand of [true, false]) {
      expect(cost({ winterSnow: true, enemyLand })).toEqual({
        lossMultiplier: 1,
        timeMultiplier: 1.25,
      });
    }
    // Mud: time only, enemy land only.
    expect(cost({ mud: true })).toEqual({
      lossMultiplier: 1,
      timeMultiplier: 1.5,
    });
    expect(cost({ mud: true, enemyLand: false })).toEqual({
      lossMultiplier: 1,
      timeMultiplier: 1,
    });
  });

  test("together they stay under 1.25x losses and 2x time, 1.5x time under a post", () => {
    expect(ENVIRONMENT_LOSS_CAP).toBe(1.25);
    expect(ENVIRONMENT_TIME_CAP).toBe(2);
    expect(ENVIRONMENT_TIME_CAP_WITH_POST).toBe(1.5);
    for (const feature of FEATURES)
      for (const enemyLand of [true, false])
        for (const winterSnow of [true, false])
          for (const mud of [true, false])
            for (const defensePost of [true, false]) {
              const c = environmentCost(
                env({ feature, enemyLand, winterSnow, mud, defensePost }),
              );
              expect(c.lossMultiplier).toBeLessThanOrEqual(1.25);
              expect(c.timeMultiplier).toBeLessThanOrEqual(
                defensePost ? 1.5 : 2,
              );
            }
    // River, winter and mud: 2 x 1.25 x 1.5 = 3.75x, capped.
    const worst = {
      feature: TerrainFeature.River,
      winterSnow: true,
      mud: true,
    };
    expect(environmentCost(env(worst)).timeMultiplier).toBe(2);
    expect(
      environmentCost(env({ ...worst, defensePost: true })).timeMultiplier,
    ).toBe(1.5);
    // Forest, winter and mud: 1.2 x 1.25 x 1.5 = 2.25x, capped.
    expect(
      environmentCost(
        env({ feature: TerrainFeature.Forest, winterSnow: true, mud: true }),
      ),
    ).toEqual({ lossMultiplier: 1.2, timeMultiplier: 2 });
  });

  test("withEnvironmentCost scales attackLogic's result in place", () => {
    const cost = {
      attackerTroopLoss: 10,
      defenderTroopLoss: 4,
      tickFraction: 0.2,
    };
    expect(
      withEnvironmentCost(cost, env({ feature: TerrainFeature.River })),
    ).toBe(cost);
    expect(cost).toEqual({
      attackerTroopLoss: 12.5,
      defenderTroopLoss: 4,
      tickFraction: 0.4,
    });
    const plain = {
      attackerTroopLoss: 10,
      defenderTroopLoss: 4,
      tickFraction: 0.2,
    };
    expect(withEnvironmentCost({ ...plain }, env({}))).toEqual(plain);
  });
});

describe("the worst tile against open ground", () => {
  const config = new EngineConfig({} as GameConfig, false);
  // Mid game: 200k into a 400k nation, both on 30k tiles, front 100.
  function cost(terrain: TerrainType, post: boolean, e: AttackEnvironment) {
    const input: AttackLogicInput = {
      terrain,
      attackTroops: 200_000,
      attacker: { type: PlayerType.Human, numTiles: 30_000 },
      defender: {
        type: PlayerType.Nation,
        numTiles: 30_000,
        troops: 400_000,
        isTraitor: false,
        isDisconnectedTeammate: false,
      },
      defenderHasDefensePost: post,
      falloutRatio: null,
      borderSize: 100,
    };
    return withEnvironmentCost(config.attackLogic(input), e);
  }
  const open = cost(TerrainType.Plains, false, env({}));
  const everything = {
    feature: TerrainFeature.River,
    winterSnow: true,
    mud: true,
  };

  test("mountain, post, river, winter and mud: 9.4x losses, 6.8x time", () => {
    const worst = cost(
      TerrainType.Mountain,
      true,
      env({ ...everything, defensePost: true }),
    );
    const loss = worst.attackerTroopLoss / open.attackerTroopLoss;
    const time = worst.tickFraction / open.tickFraction;
    // 1.5 (mountain) x 5 (post) x 1.25 (river).
    expect(loss).toBeCloseTo(9.375, 9);
    // 25 / 16.5 (mountain) x 3 (post) x 1.5 (capped).
    expect(time).toBeCloseTo((25 / 16.5) * 3 * 1.5, 9);
    expect(time).toBeLessThan(6.82);
  });

  test("without a post: at most 1.9x losses and 3.0x time", () => {
    const worst = cost(TerrainType.Mountain, false, env(everything));
    expect(worst.attackerTroopLoss / open.attackerTroopLoss).toBeCloseTo(
      1.875,
      9,
    );
    expect(worst.tickFraction / open.tickFraction).toBeCloseTo(
      (25 / 16.5) * 2,
      9,
    );
  });
});
