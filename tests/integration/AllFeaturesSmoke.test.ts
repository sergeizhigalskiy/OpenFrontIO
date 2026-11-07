/**
 * Smoke run of the merged game: every default-on feature at once (ruins,
 * city-states, seasons, weather, defense post levels, rail cuts and
 * blockades), plus each lobby mode in turn: Boss Raid, Horde Night, the
 * plague, volcanoes and the rising tide. Each game runs through GameRunner
 * with the real production rules and nations on the world test map, long
 * enough for its mode to act, and must never throw.
 *
 * Not a balance test: it only checks that the features run together.
 */
import {
  Cell,
  Difficulty,
  GameMode,
  Nation,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import {
  CataclysmUpdate,
  GameUpdateType,
} from "@openfront/engine-api/game/GameUpdates";
import { GameConfig } from "@openfront/engine-api/Schemas";
import {
  HORDE_FIRST_WAVE_DELAY_TICKS,
  isHordeBand,
} from "@openfront/engine-lib/game/HordeNight";
import {
  INFECTED_PLAYER_ID,
  PLAGUE_OUTBREAK_DELAY_TICKS,
} from "@openfront/engine-lib/game/Plague";
import { RISING_TIDE_FIRST_WAVE_TICKS } from "@openfront/engine-lib/game/RisingTide";
import { VOLCANO_FIRST_RUMBLE_TICKS } from "@openfront/engine-lib/game/Volcanoes";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { Executor } from "@openfront/engine/execution/ExecutionManager";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game } from "@openfront/engine/game/Game";
import { GameRunner } from "@openfront/engine/GameRunner";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { setup } from "../util/Setup";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Nations from the world map manifest: enough to fight, few enough to be quick. */
const NATIONS = 16;
/** Ticks the spawn phase gets before it is ended. */
const SPAWN_TICKS = 30;
/** Ticks after the spawn phase for the modes that act early. */
const BASE_TICKS = 2_200;

function worldNations(): Nation[] {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../testdata/maps/world/manifest.json"),
      "utf8",
    ),
  ) as { nations: { coordinates: [number, number]; name: string }[] };
  return manifest.nations
    .slice(0, NATIONS)
    .map(
      (n) =>
        new Nation(
          new Cell(n.coordinates[0], n.coordinates[1]),
          new PlayerInfo(n.name, PlayerType.Nation, null, n.name),
        ),
    );
}

// Every default-on feature is on when absent. Hard nations upgrade posts.
const DEFAULTS: Partial<GameConfig> = {
  difficulty: Difficulty.Hard,
  bots: 40,
};

/** What a run saw on the update stream. */
interface Seen {
  types: Set<GameUpdateType>;
  eruptions: number;
  tideWaves: number;
}

interface Mode {
  name: string;
  config: Partial<GameConfig>;
  /** Ticks after the spawn phase, enough for the mode to act. */
  ticks: number;
  /** That the mode acted, from the game and its updates afterwards. */
  check: (game: Game, seen: Seen) => void;
}

const MODES: Mode[] = [
  {
    name: "Boss Raid",
    config: {
      gameMode: GameMode.Team,
      playerTeams: 2,
      bossRaid: { boss: "nation" },
      maxTimerValue: 25,
    },
    ticks: BASE_TICKS,
    check: (game) => {
      expect(game.config().bossRaidRaiderWeight()).toBeGreaterThan(0);
    },
  },
  {
    name: "Horde Night",
    config: { hordeNight: { enabled: true, survivalMinutes: 30 } },
    ticks: HORDE_FIRST_WAVE_DELAY_TICKS + 400,
    // The first wave landed.
    check: (game) =>
      expect(game.allPlayers().some((p) => isHordeBand(p))).toBe(true),
  },
  {
    name: "plague",
    config: { plague: true },
    ticks: PLAGUE_OUTBREAK_DELAY_TICKS + 400,
    // The Infected broke out.
    check: (game) => expect(game.hasPlayer(INFECTED_PLAYER_ID)).toBe(true),
  },
  {
    name: "volcanoes",
    config: { volcanoes: true },
    // Past the first rumble and its eruption.
    ticks: VOLCANO_FIRST_RUMBLE_TICKS + 300,
    check: (_, seen) => expect(seen.eruptions).toBeGreaterThan(0),
  },
  {
    name: "rising tide",
    config: { risingTide: true },
    // Past the first wave.
    ticks: RISING_TIDE_FIRST_WAVE_TICKS + 50,
    check: (_, seen) => expect(seen.tideWaves).toBeGreaterThan(0),
  },
];

async function run(mode: Mode): Promise<void> {
  const nations = worldNations();
  const human = new PlayerInfo("human", PlayerType.Human, "Hu000000", "human");
  const game = await setup(
    "world",
    { ...DEFAULTS, ...mode.config },
    [human],
    undefined,
    EngineConfig,
    false,
    nations,
  );
  let error: string | null = null;
  const seen: Seen = { types: new Set(), eruptions: 0, tideWaves: 0 };
  const runner = new GameRunner(
    game,
    new Executor(game, `smoke_${mode.name}`, undefined),
    (gu) => {
      if ("errMsg" in gu) {
        error = `${gu.errMsg}\n${gu.stack ?? ""}`;
        return;
      }
      for (const [type, updates] of Object.entries(gu.updates)) {
        if ((updates as unknown[]).length > 0) seen.types.add(Number(type));
      }
      for (const u of gu.updates[
        GameUpdateType.Cataclysm
      ] as CataclysmUpdate[]) {
        if (u.kind === "volcano" && u.eruptedSite !== null) seen.eruptions++;
        if (u.kind === "tide")
          seen.tideWaves = Math.max(seen.tideWaves, u.wave);
      }
    },
  );
  runner.init();
  // The human spawns on the land of the first nation's cell's neighbor.
  const cell = nations[0].spawnCell!;
  game.addExecution(
    new SpawnExecution(
      `smoke_${mode.name}`,
      human,
      game.ref(cell.x + 40, cell.y + 20),
    ),
  );
  const total = SPAWN_TICKS + mode.ticks;
  for (let t = 0; t < total; t++) {
    if (t === SPAWN_TICKS) game.endSpawnPhase();
    runner.addTurn({ turnNumber: t, intents: [] });
    runner.executeNextTick();
    if (error !== null) throw new Error(`${mode.name}, tick ${t}: ${error}`);
  }
  // Every default-on feature was in the game.
  expect(
    game.ruins().size + game.allPlayers().filter((p) => p.isCityState()).length,
  ).toBeGreaterThan(0);
  expect(game.config().seasonsEnabled() && game.config().weatherEnabled()).toBe(
    true,
  );
  mode.check(game, seen);
}

describe("every feature together, each mode in turn", () => {
  test.each(MODES)("$name runs without throwing", run, 60_000);
});
