import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  Nation,
} from "@openfront/engine-api/game/GameTypes";
import {
  AdditionalNation,
  Nation as ManifestNation,
} from "@openfront/engine-api/game/MapFiles";
import { GameConfig, GameStartInfo } from "@openfront/engine-api/Schemas";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import {
  createNationsForGame,
  withProtectedStateNation,
} from "@openfront/engine/game/NationCreation";

function makeManifestNations(count: number): ManifestNation[] {
  const result: ManifestNation[] = [];
  for (let i = 0; i < count; i++) {
    result.push({
      coordinates: [i, i],
      flag: "",
      name: `Manifest${i}`,
    });
  }
  return result;
}

function makeAdditionalNations(names: string[]): AdditionalNation[] {
  return names.map((name) => ({ name }));
}

function makeGameStart(targetNations: number): GameStartInfo {
  const config: GameConfig = {
    gameMap: GameMapType.World,
    gameMapSize: GameMapSize.Normal,
    gameMode: GameMode.FFA,
    gameType: GameType.Singleplayer,
    difficulty: Difficulty.Medium,
    nations: targetNations,
    donateGold: false,
    donateTroops: false,
    bots: 0,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
  return {
    gameID: "test1234",
    lobbyCreatedAt: 0,
    config,
    players: [],
  };
}

function nationNames(nations: Nation[]): string[] {
  return nations.map((n) => n.playerInfo.name);
}

describe("createNationsForGame: additionalNations pool", () => {
  test("does not draw from the pool when manifest already covers the count", () => {
    const manifest = makeManifestNations(4);
    const extras = makeAdditionalNations(["ExtraA", "ExtraB", "ExtraC"]);
    const random = new PseudoRandom(1);

    const nations = createNationsForGame(
      makeGameStart(3),
      manifest,
      extras,
      0,
      random,
    );

    expect(nations).toHaveLength(3);
    for (const name of nationNames(nations)) {
      expect(name.startsWith("Manifest")).toBe(true);
    }
  });

  test("fills the deficit entirely from the pool when it is large enough", () => {
    const manifest = makeManifestNations(2);
    const extras = makeAdditionalNations([
      "ExtraA",
      "ExtraB",
      "ExtraC",
      "ExtraD",
      "ExtraE",
    ]);
    const random = new PseudoRandom(7);

    const nations = createNationsForGame(
      makeGameStart(5),
      manifest,
      extras,
      0,
      random,
    );

    expect(nations).toHaveLength(5);
    const names = nationNames(nations);

    expect(names.filter((n) => n.startsWith("Manifest"))).toHaveLength(2);

    const fromPool = names.filter((n) => n.startsWith("Extra"));
    expect(fromPool).toHaveLength(3);
    for (const name of fromPool) {
      expect(extras.some((e) => e.name === name)).toBe(true);
    }
  });

  test("randomly selects from the pool when it has more entries than needed", () => {
    const manifest = makeManifestNations(2);
    const pool = [
      "ExtraA",
      "ExtraB",
      "ExtraC",
      "ExtraD",
      "ExtraE",
      "ExtraF",
      "ExtraG",
      "ExtraH",
    ];
    const extras = makeAdditionalNations(pool);

    const seen = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const random = new PseudoRandom(seed);
      const nations = createNationsForGame(
        makeGameStart(4),
        manifest,
        extras,
        0,
        random,
      );
      expect(nations).toHaveLength(4);

      const fromPool = nationNames(nations).filter((n) =>
        n.startsWith("Extra"),
      );
      expect(fromPool).toHaveLength(2);
      for (const name of fromPool) {
        expect(pool).toContain(name);
      }
      fromPool.forEach((n) => seen.add(n));
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  test("falls back to generated names when the pool is too small", () => {
    const manifest = makeManifestNations(1);
    const extras = makeAdditionalNations(["ExtraA", "ExtraB"]);
    const random = new PseudoRandom(42);

    const nations = createNationsForGame(
      makeGameStart(5),
      manifest,
      extras,
      0,
      random,
    );

    expect(nations).toHaveLength(5);
    const names = nationNames(nations);

    expect(names.filter((n) => n.startsWith("Manifest"))).toHaveLength(1);

    const fromPool = names.filter((n) => extras.some((e) => e.name === n));
    expect(fromPool).toHaveLength(2);

    const generated = names.filter(
      (n) => !n.startsWith("Manifest") && !extras.some((e) => e.name === n),
    );
    expect(generated).toHaveLength(2);
  });

  test("falls back to generated names when the pool is empty", () => {
    const manifest = makeManifestNations(2);
    const random = new PseudoRandom(11);

    const nations = createNationsForGame(
      makeGameStart(4),
      manifest,
      [],
      0,
      random,
    );

    expect(nations).toHaveLength(4);
    expect(
      nationNames(nations).filter((n) => n.startsWith("Manifest")),
    ).toHaveLength(2);
  });

  test("skips pool entries whose name collides with a manifest nation", () => {
    const manifest = makeManifestNations(2);
    const extras = makeAdditionalNations([
      "Manifest0",
      "Manifest1",
      "UniqueExtra",
    ]);
    const random = new PseudoRandom(3);

    const nations = createNationsForGame(
      makeGameStart(3),
      manifest,
      extras,
      0,
      random,
    );

    const names = nationNames(nations);
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("UniqueExtra");
  });

  test("uses coordinates from additional nations when provided", () => {
    const manifest = makeManifestNations(1);
    const extras: AdditionalNation[] = [
      { name: "WithCoords", coordinates: [42, 99] },
      { name: "WithoutCoords" },
    ];
    const random = new PseudoRandom(5);

    const nations = createNationsForGame(
      makeGameStart(3),
      manifest,
      extras,
      0,
      random,
    );

    const withCoords = nations.find((n) => n.playerInfo.name === "WithCoords");
    const withoutCoords = nations.find(
      (n) => n.playerInfo.name === "WithoutCoords",
    );

    expect(withCoords).toBeDefined();
    expect(withoutCoords).toBeDefined();
    expect(withCoords!.spawnCell?.x).toBe(42);
    expect(withCoords!.spawnCell?.y).toBe(99);
    expect(withoutCoords!.spawnCell).toBeUndefined();
  });

  test("uses coordinates from manifest nations when provided, undefined when omitted", () => {
    const manifest: ManifestNation[] = [
      { name: "WithCoords", coordinates: [10, 20] },
      { name: "WithoutCoords" },
    ];
    const random = new PseudoRandom(5);

    const nations = createNationsForGame(
      makeGameStart(2),
      manifest,
      [],
      0,
      random,
    );

    expect(nations).toHaveLength(2);
    const withCoords = nations.find((n) => n.playerInfo.name === "WithCoords");
    const withoutCoords = nations.find(
      (n) => n.playerInfo.name === "WithoutCoords",
    );

    expect(withCoords).toBeDefined();
    expect(withoutCoords).toBeDefined();
    expect(withCoords!.spawnCell?.x).toBe(10);
    expect(withCoords!.spawnCell?.y).toBe(20);
    expect(withoutCoords!.spawnCell).toBeUndefined();
  });

  test("carries each manifest nation's own flag through, even when names collide", () => {
    // Regression test: maps can define multiple nations with the same display
    // name (e.g. India's and Pakistan's "Punjab", split by the 1947
    // partition). Each Nation instance must keep its own flag rather than
    // depending on a name-keyed lookup that only the last-defined one wins.
    const manifest: ManifestNation[] = [
      { coordinates: [840, 305], name: "Punjab", flag: "in" },
      { coordinates: [637, 464], name: "Punjab", flag: "pk" },
    ];
    const random = new PseudoRandom(5);

    const nations = createNationsForGame(
      makeGameStart(2),
      manifest,
      [],
      0,
      random,
    );

    expect(nations).toHaveLength(2);
    const flags = nations.map((n) => n.playerInfo.nationFlag).sort();
    expect(flags).toEqual(["in", "pk"]);
  });

  test("carries flags from additionalNations through too", () => {
    const manifest = makeManifestNations(1);
    const extras: AdditionalNation[] = [
      { name: "WithFlag", flag: "fr" },
      { name: "WithoutFlag" },
    ];
    const random = new PseudoRandom(5);

    const nations = createNationsForGame(
      makeGameStart(3),
      manifest,
      extras,
      0,
      random,
    );

    const withFlag = nations.find((n) => n.playerInfo.name === "WithFlag");
    const withoutFlag = nations.find(
      (n) => n.playerInfo.name === "WithoutFlag",
    );

    expect(withFlag!.playerInfo.nationFlag).toBe("fr");
    expect(withoutFlag!.playerInfo.nationFlag).toBeNull();
  });

  test("produces unique nation names overall", () => {
    const manifest = makeManifestNations(3);
    const extras = makeAdditionalNations(["Ex1", "Ex2", "Ex3"]);
    const random = new PseudoRandom(99);

    const nations = createNationsForGame(
      makeGameStart(8),
      manifest,
      extras,
      0,
      random,
    );

    const names = nationNames(nations);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });
});

describe("withProtectedStateNation: the named nation always spawns", () => {
  const toNation =
    (random: PseudoRandom) =>
    (n: ManifestNation): Nation =>
      new Nation(undefined, {
        name: n.name,
        flag: n.flag ?? null,
        id: random.nextID(),
      } as unknown as Nation["playerInfo"]);

  test("leaves the nations alone when the named one is already there", () => {
    const random = new PseudoRandom(5);
    const manifest = makeManifestNations(4);
    const nations = manifest.map(toNation(random));
    const out = withProtectedStateNation(
      nations,
      makeGameStart(4).config,
      false,
      manifest,
      toNation(random),
      random,
      "manifest2",
    );
    expect(out).toBe(nations);
  });

  test("swaps it in for the last drawn nation when a random draw left it out", () => {
    const random = new PseudoRandom(5);
    const manifest = makeManifestNations(6);
    const drawn = manifest.slice(0, 3).map(toNation(random));
    const out = withProtectedStateNation(
      drawn,
      makeGameStart(3).config,
      true,
      manifest,
      toNation(random),
      random,
      "Manifest5",
    );
    expect(nationNames(out)).toEqual(["Manifest0", "Manifest1", "Manifest5"]);
  });

  test("adds a nation the map lacks at its listed spot, halved on compact maps", () => {
    const random = new PseudoRandom(5);
    const manifest = makeManifestNations(3);
    const nations = manifest.map(toNation(random));
    const config = makeGameStart(3).config;
    const out = withProtectedStateNation(
      nations,
      config,
      false,
      manifest,
      toNation(random),
      random,
      "Israel",
    );
    expect(out).toHaveLength(4);
    const added = out[3];
    expect(added.playerInfo.name).toBe("Israel");
    expect(added.playerInfo.nationFlag).toBe("il");
    expect(added.spawnCell?.x).toBe(1131);
    expect(added.spawnCell?.y).toBe(316);

    const compact = withProtectedStateNation(
      nations,
      { ...config, gameMapSize: GameMapSize.Compact },
      false,
      manifest,
      toNation(random),
      random,
      "Israel",
    );
    expect(compact[3].spawnCell?.x).toBe(565);
    expect(compact[3].spawnCell?.y).toBe(158);
  });

  test("adds a nation with no listed spot without one", () => {
    const random = new PseudoRandom(5);
    const manifest = makeManifestNations(2);
    const out = withProtectedStateNation(
      manifest.map(toNation(random)),
      makeGameStart(2).config,
      false,
      manifest,
      toNation(random),
      random,
      "Atlantis",
    );
    expect(nationNames(out)).toEqual(["Manifest0", "Manifest1", "Atlantis"]);
    expect(out[2].spawnCell).toBeUndefined();
  });

  test("does nothing when no nation is named, and createNationsForGame skips it with the mode off", () => {
    const random = new PseudoRandom(5);
    const manifest = makeManifestNations(2);
    const nations = manifest.map(toNation(random));
    expect(
      withProtectedStateNation(
        nations,
        makeGameStart(2).config,
        false,
        manifest,
        toNation(random),
        random,
        null,
      ),
    ).toBe(nations);

    const off = createNationsForGame(
      makeGameStart(2),
      manifest,
      [],
      0,
      new PseudoRandom(9),
    );
    expect(off).toHaveLength(2);
  });
});
