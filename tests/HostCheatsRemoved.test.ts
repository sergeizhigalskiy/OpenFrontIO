import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import {
  GameConfig,
  GameConfigPatchSchema,
  GameConfigSchema,
} from "@openfront/engine-api/Schemas";
import { SpawnExecution } from "@openfront/engine/execution/SpawnExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

// The private-lobby "host cheats" (infinite gold and troops, a gold multiplier
// and starting gold for the lobby creator only) are gone. A config written
// before that can still carry the block: it has to load, and grant nothing.
// The everyone-wide options with the same names stay.

const LEGACY_HOST_CHEATS = {
  infiniteGold: true,
  infiniteTroops: true,
  goldMultiplier: 5,
  startingGold: 5_000_000,
};

const BASE_CONFIG: GameConfig = {
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
};

const HOST = new PlayerInfo("host", PlayerType.Human, null, "host_id", true);
const GUEST = new PlayerInfo("guest", PlayerType.Human, null, "guest_id");

// Both humans spawn on open plains, mirrored, and play a few seconds.
async function play(gameConfig: Record<string, unknown>): Promise<{
  game: Game;
  host: Player;
  guest: Player;
}> {
  const game = await setup("plains", gameConfig as Partial<GameConfig>);
  game.addPlayer(HOST);
  game.addPlayer(GUEST);
  game.addExecution(
    new SpawnExecution("game_id", HOST, game.ref(25, 50)),
    new SpawnExecution("game_id", GUEST, game.ref(75, 50)),
  );
  for (let i = 0; i < 50; i++) game.executeNextTick();
  return {
    game,
    host: game.player(HOST.id),
    guest: game.player(GUEST.id),
  };
}

const cityCost = (game: Game, p: Player) =>
  game.config().unitInfo(UnitType.City).cost(game, p);

describe("host cheats are gone", () => {
  it("an old config carrying hostCheats parses with the block dropped", () => {
    const legacy = { ...BASE_CONFIG, hostCheats: LEGACY_HOST_CHEATS };
    const parsed = GameConfigSchema.parse(legacy);
    expect(parsed).not.toHaveProperty("hostCheats");
    expect(parsed).toEqual(GameConfigSchema.parse(BASE_CONFIG));

    const patch = GameConfigPatchSchema.parse({
      bots: 3,
      hostCheats: LEGACY_HOST_CHEATS,
    });
    expect(patch).toEqual({ bots: 3 });
  });

  it("hostCheats.infiniteTroops gives the lobby creator nothing extra", async () => {
    const cheat = await play({ hostCheats: { infiniteTroops: true } });
    const plain = await play({});
    const config = cheat.game.config();

    expect(config.startManpower(HOST)).toBe(25_000);
    expect(config.startManpower(HOST)).toBe(config.startManpower(GUEST));
    expect(cheat.host.troops()).toBe(plain.host.troops());
    expect(cheat.host.troops()).toBe(cheat.guest.troops());
    expect(config.maxTroops(cheat.host)).toBe(
      plain.game.config().maxTroops(plain.host),
    );
    expect(config.maxTroops(cheat.host)).toBe(config.maxTroops(cheat.guest));
    expect(config.maxTroops(cheat.host)).toBeLessThan(1_000_000);
  });

  it("the rest of the old block gives the lobby creator nothing extra either", async () => {
    const cheat = await play({ hostCheats: LEGACY_HOST_CHEATS });
    const plain = await play({});
    const config = cheat.game.config();

    expect(config.startingGold(HOST)).toBe(0n);
    expect(cheat.host.gold()).toBe(plain.host.gold());
    expect(cheat.host.gold()).toBe(cheat.guest.gold());
    expect(config.goldAdditionRate(cheat.host)).toBe(100n);
    expect(config.tradeShipGold(500, cheat.host)).toBe(
      config.tradeShipGold(500, cheat.guest),
    );
    expect(cityCost(cheat.game, cheat.host)).toBe(
      cityCost(plain.game, plain.host),
    );
    expect(cityCost(cheat.game, cheat.host)).toBeGreaterThan(0n);
  });

  it("the everyone-wide options still apply to every human alike", async () => {
    const { game, host, guest } = await play({
      infiniteGold: true,
      infiniteTroops: true,
      goldMultiplier: 2,
      startingGold: 3_000_000,
    });
    const config = game.config();

    for (const info of [HOST, GUEST]) {
      expect(config.startManpower(info)).toBe(1_000_000);
      expect(config.startingGold(info)).toBe(3_000_000n);
    }
    for (const p of [host, guest]) {
      expect(config.maxTroops(p)).toBe(1_000_000_000);
      expect(config.goldAdditionRate(p)).toBe(200n);
      expect(cityCost(game, p)).toBe(0n);
    }
    expect(config.tradeShipGold(500, host)).toBe(
      config.tradeShipGold(500, guest),
    );
  });
});
