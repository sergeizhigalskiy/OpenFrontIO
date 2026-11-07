import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { GameUpdateType } from "@openfront/engine-api/game/GameUpdates";
import {
  GameConfig,
  GameConfigPatchSchema,
  GameConfigSchema,
} from "@openfront/engine-api/Schemas";
import { readVersioned } from "@openfront/engine-lib/snapshot/SnapshotType";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { AiAttackBehaviorSnapshot } from "@openfront/engine/execution/utils/AiAttackBehavior";
import { Game } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import { EXECUTION_SNAPSHOT_TYPES } from "@openfront/engine/snapshot/ExecutionRegistry";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { COLUMN_IDS } from "../src/client/StatsConstants";
import { setup } from "./util/Setup";

// The resource sites (gold mines, oil fields and fishing grounds) are gone.
// A config, preset or lobby written before that can still carry the
// resourceSites toggle: it has to load, and place, pay and announce nothing.
// Ruins and city-states stay.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GAME_ID = "no_sites";
const A = new PlayerInfo("a", PlayerType.Human, "Ca000000", "a");
const B = new PlayerInfo("b", PlayerType.Human, "Cb000000", "b");
/** Ticks the spawn phase gets before it is ended. */
const SPAWN_TICKS = 10;
/**
 * Ticks after it: past the 600 (60 s) after which the sites used to pay
 * their holders every tick.
 */
const PLAY_TICKS = 700;

/**
 * Two humans on open plains through GameRunner, as a real game starts. A few
 * ticks after the spawn phase `a` takes every land tile `b` doesn't hold,
 * where the old sites went down, then both sit until well past the first
 * site payment.
 */
async function play(gameConfig: Record<string, unknown>): Promise<{
  game: Game;
  updateTypes: Set<number>;
}> {
  const game = await setup(
    "plains",
    gameConfig as Partial<GameConfig>,
    [A, B],
    undefined,
    undefined,
    false,
  );
  const updateTypes = new Set<number>();
  let error: string | null = null;
  const runner = new GameRunner(
    game,
    new Executor(game, GAME_ID, undefined),
    (gu) => {
      if ("errMsg" in gu) {
        error = gu.errMsg;
        return;
      }
      for (const [type, updates] of Object.entries(gu.updates)) {
        if ((updates as unknown[]).length > 0) updateTypes.add(Number(type));
      }
    },
  );
  runner.init();
  game.addExecution(
    new SpawnExecution(GAME_ID, A, game.ref(25, 50)),
    new SpawnExecution(GAME_ID, B, game.ref(75, 50)),
  );
  const total = SPAWN_TICKS + PLAY_TICKS;
  for (let t = 0; t < total; t++) {
    if (t === SPAWN_TICKS) game.endSpawnPhase();
    if (t === SPAWN_TICKS + 5) {
      const a = game.player(A.id);
      const b = game.player(B.id);
      game.forEachTile((tile) => {
        if (game.isLand(tile) && game.owner(tile) !== b) a.conquer(tile);
      });
    }
    runner.addTurn({ turnNumber: t, intents: [] });
    runner.executeNextTick();
    if (error !== null) throw new Error(`tick ${t}: ${error}`);
  }
  return { game, updateTypes };
}

describe("resource sites are gone", () => {
  it("an old config carrying resourceSites parses with it dropped", () => {
    const base = GameConfigSchema.parse({
      gameMap: GameMapType.World,
      gameMapSize: GameMapSize.Normal,
      difficulty: Difficulty.Medium,
      donateGold: false,
      donateTroops: false,
      gameType: GameType.Private,
      gameMode: GameMode.FFA,
      nations: "default",
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
    } satisfies GameConfig);
    const legacy = GameConfigSchema.parse({ ...base, resourceSites: true });
    expect(legacy).not.toHaveProperty("resourceSites");
    expect(legacy).toEqual(base);

    const patch = GameConfigPatchSchema.parse({ bots: 3, resourceSites: true });
    expect(patch).toEqual({ bots: 3 });
  });

  it("a game started with resourceSites on places, pays and announces nothing", async () => {
    const legacy = await play({ resourceSites: true });
    const plain = await play({});

    // Every update the engine sent is one it still has: no site list.
    for (const type of legacy.updateTypes) {
      expect(GameUpdateType[type], `update type ${type}`).toBeDefined();
    }
    expect([...legacy.updateTypes].sort()).toEqual(
      [...plain.updateTypes].sort(),
    );

    // `a` holds every tile a site could sit on, and is paid exactly what it
    // is paid without the toggle: passive income, nothing per site.
    for (const id of [A.id, B.id]) {
      const was = legacy.game.player(id);
      const now = plain.game.player(id);
      expect(was.gold()).toBe(now.gold());
      expect(was.numTilesOwned()).toBe(now.numTilesOwned());
      expect(was.troops()).toBe(now.troops());
    }
    expect(legacy.game.player(A.id).numTilesOwned()).toBeGreaterThan(9_000);
    expect(legacy.game.player(A.id).gold()).toBeGreaterThan(0n);
  }, 60_000);

  it("the snapshot keeps no ResourceSite record, and old nation records load without their sites", () => {
    expect(EXECUTION_SNAPSHOT_TYPES.map((t) => t.name)).not.toContain(
      "ResourceSite",
    );
    expect(AiAttackBehaviorSnapshot.version).toBe(5);

    // A v3 nation remembered the sites it held and lost.
    const current = {
      botAttackTroopsSent: 12,
      followedLandings: [],
      triggerRatio: 0.5,
      reserveRatio: 0.3,
      expandRatio: 0.1,
      stallWatch: [],
      salientCut: null,
    };
    const v3 = {
      ...current,
      sitesHeld: new Uint32Array([101, 202]),
      sitesLost: new Uint32Array([303]),
    };
    const read = readVersioned(AiAttackBehaviorSnapshot, { v: 3, d: v3 });
    expect(read).toEqual(current);
    expect(read).not.toHaveProperty("sitesHeld");
    expect(read).not.toHaveProperty("sitesLost");
    // A v4 from this branch (no sites) loads too.
    const v4: Record<string, unknown> = { ...current };
    delete v4.salientCut;
    expect(readVersioned(AiAttackBehaviorSnapshot, { v: 4, d: v4 })).toEqual(
      current,
    );
    // An older one still steps through to the current layout.
    const v2 = {
      botAttackTroopsSent: 0,
      followedLandings: [],
      triggerRatio: 0.5,
      reserveRatio: 0.3,
      expandRatio: 0.1,
    };
    expect(readVersioned(AiAttackBehaviorSnapshot, { v: 2, d: v2 })).toEqual({
      ...v2,
      stallWatch: [],
      salientCut: null,
    });
  });

  it("no lobby text, hover card or leaderboard column is left", () => {
    const en = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../resources/lang/en.json"),
        "utf8",
      ),
    );
    expect(en.resource_sites).toBeUndefined();
    expect(en.game_settings.resource_sites).toBeUndefined();
    expect(en.leaderboard.mines).toBeUndefined();
    expect(en.leaderboard.mineGoldPerMin).toBeUndefined();
    // Ruins and city-states stay.
    expect(en.game_settings.ruins).toBeDefined();
    expect(en.game_settings.city_states).toBeDefined();

    expect(COLUMN_IDS as readonly string[]).not.toContain("mines");
    expect(COLUMN_IDS as readonly string[]).not.toContain("mineGoldPerMin");
  });
});
