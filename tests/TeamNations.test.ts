import {
  ColoredTeams,
  Difficulty,
  GameMode,
  HumansVsNations,
  PlayerInfo,
  PlayerType,
  Team,
} from "@openfront/engine-api/game/GameTypes";
import {
  assignTeams,
  harderDifficulty,
  HUMAN_TEAM_POINTS,
  NATION_EXTRA_SEATS,
  NATION_TEAM_POINTS,
  previewTeamNations,
  resolveTeamsList,
  STACKED_IMPOSSIBLE_GROWTH_PERCENT,
  stackedTeams,
  stackedTeamsOf,
} from "@openfront/engine-lib/game/TeamAssignment";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";

const RED = ColoredTeams.Red;
const BLUE = ColoredTeams.Blue;
const teams = [RED, BLUE];

const human = (i: number, teamIndex: number | null = null) =>
  new PlayerInfo(
    `human${i}`,
    PlayerType.Human,
    `client${i}`,
    `h${i}`,
    false,
    null,
    [],
    teamIndex,
  );
const nation = (i: number) =>
  new PlayerInfo(`nation${i}`, PlayerType.Nation, null, `n${i}`);

/** Nations dealt to each team. */
function nationsPerTeam(
  result: Map<PlayerInfo, Team | "kicked">,
): Map<Team | "kicked", number> {
  const counts = new Map<Team | "kicked", number>();
  for (const [p, team] of result) {
    if (p.playerType !== PlayerType.Nation) continue;
    counts.set(team, (counts.get(team) ?? 0) + 1);
  }
  return counts;
}

describe("dealing nations by points", () => {
  test("points: human 3, Easy 0.5, Medium 0.75, Hard 1, Impossible 1.25", () => {
    expect(HUMAN_TEAM_POINTS).toBe(3);
    expect(NATION_TEAM_POINTS).toEqual({
      [Difficulty.Easy]: 0.5,
      [Difficulty.Medium]: 0.75,
      [Difficulty.Hard]: 1,
      [Difficulty.Impossible]: 1.25,
    });
    expect(NATION_EXTRA_SEATS).toBe(3);
  });

  test("Hard: two humans on one team get two nations, the other team eight", () => {
    // Red holds 6 points of humans. Blue is dealt nations until it matches,
    // then they alternate (ties go to the team with fewer seats).
    const humans = [human(0, 0), human(1, 0)];
    const nations = Array.from({ length: 10 }, (_, i) => nation(i));
    const result = assignTeams(
      [...humans, ...nations],
      teams,
      false,
      undefined,
      Difficulty.Hard,
    );
    expect(nationsPerTeam(result)).toEqual(
      new Map([
        [BLUE, 8],
        [RED, 2],
      ]),
    );
  });

  test("Impossible nations are worth more, so fewer go to the weaker side", () => {
    const humans = [human(0, 0), human(1, 0)];
    const nations = Array.from({ length: 10 }, (_, i) => nation(i));
    const result = assignTeams(
      [...humans, ...nations],
      teams,
      false,
      undefined,
      Difficulty.Impossible,
    );
    // Blue reaches 6.25 points after 5 nations; then they alternate.
    const counts = nationsPerTeam(result);
    expect(counts.get(BLUE)).toBe(7);
    expect(counts.get(RED)).toBe(3);
  });

  test("a team takes at most 3 seats past the size limit, for nations", () => {
    // Easy nations are worth 0.5: Blue would need 12 to match Red's two
    // humans, but holds at most maxTeamSize (6) + 3 = 9 seats.
    const humans = [human(0, 0), human(1, 0)];
    const nations = Array.from({ length: 10 }, (_, i) => nation(i));
    const result = assignTeams(
      [...humans, ...nations],
      teams,
      false,
      undefined,
      Difficulty.Easy,
    );
    const counts = nationsPerTeam(result);
    expect(counts.get(BLUE)).toBe(6 + NATION_EXTRA_SEATS);
    expect(counts.get(RED)).toBe(1);
  });

  test("the team size limit counts humans only", () => {
    // 4 humans and 4 nations on 2 teams: 4 seats a team. Four humans fit on
    // Red, and its nations still find seats beyond the limit.
    const humans = [0, 1, 2, 3].map((i) => human(i, 0));
    const nations = Array.from({ length: 4 }, (_, i) => nation(i));
    const result = assignTeams(
      [...humans, ...nations],
      teams,
      false,
      undefined,
      Difficulty.Hard,
    );
    for (const h of humans) expect(result.get(h)).toBe(RED);
    expect(nationsPerTeam(result).get(BLUE)).toBe(4);
  });
});

describe("stacked teams", () => {
  test("teams differing by more than one human are stacked", () => {
    expect(
      stackedTeams(
        new Map([
          [RED, 1],
          [BLUE, 0],
        ]),
      ),
    ).toEqual([]);
    expect(
      stackedTeams(
        new Map([
          [RED, 2],
          [BLUE, 1],
        ]),
      ),
    ).toEqual([]);
    expect(
      stackedTeams(
        new Map([
          [RED, 2],
          [BLUE, 0],
        ]),
      ),
    ).toEqual([BLUE]);
    // Only teams two or more humans short play harder.
    expect(
      stackedTeams(
        new Map([
          [RED, 3],
          [BLUE, 2],
          [ColoredTeams.Yellow, 0],
          [ColoredTeams.Green, 1],
        ]),
      ),
    ).toEqual([ColoredTeams.Green, ColoredTeams.Yellow]);
  });

  test("one difficulty harder; Impossible grows 10% faster instead", () => {
    expect(harderDifficulty(Difficulty.Easy)).toBe(Difficulty.Medium);
    expect(harderDifficulty(Difficulty.Medium)).toBe(Difficulty.Hard);
    expect(harderDifficulty(Difficulty.Hard)).toBe(Difficulty.Impossible);
    expect(harderDifficulty(Difficulty.Impossible)).toBe(Difficulty.Impossible);
    expect(STACKED_IMPOSSIBLE_GROWTH_PERCENT).toBe(110);
  });

  test("only plain team games are stacked", () => {
    const players = [
      { team: () => RED, type: () => PlayerType.Human },
      { team: () => RED, type: () => PlayerType.Human },
      { team: () => BLUE, type: () => PlayerType.Nation },
    ];
    const team = { gameMode: GameMode.Team, playerTeams: 2 as const };
    expect(stackedTeamsOf(team, players)).toEqual([BLUE]);
    expect(
      stackedTeamsOf({ ...team, playerTeams: HumansVsNations }, players),
    ).toEqual([]);
    expect(
      stackedTeamsOf({ ...team, bossRaid: { boss: "nation" } }, players),
    ).toEqual([]);
    expect(
      stackedTeamsOf({ ...team, hordeNight: { enabled: true } }, players),
    ).toEqual([]);
    expect(stackedTeamsOf({ gameMode: GameMode.FFA }, players)).toEqual([]);
  });
});

describe("stacked teams in a game", () => {
  // Two humans pinned to Red against ten nations.
  async function stackedGame(difficulty: Difficulty) {
    const humans = [human(0, 0), human(1, 0)];
    const nations = Array.from({ length: 10 }, (_, i) => nation(i));
    const game = await setup(
      "big_plains",
      { gameMode: GameMode.Team, playerTeams: 2, difficulty },
      [...humans, ...nations],
    );
    const nationsOn = (team: Team) =>
      game
        .allPlayers()
        .filter((p) => p.type() === PlayerType.Nation && p.team() === team);
    return { game, humans, nationsOn };
  }

  /** Gives two players the same land and troops. */
  function level(game: Game, a: Player, b: Player) {
    let i = 0;
    game.map().forEachTile((tile) => {
      if (!game.isLand(tile) || i >= 200) return;
      (i % 2 === 0 ? a : b).conquer(tile);
      i++;
    });
    a.setTroops(50_000);
    b.setTroops(50_000);
  }

  test("the game records the short-handed team and its nations play harder", async () => {
    const { game, nationsOn } = await stackedGame(Difficulty.Hard);
    expect(game.config().gameConfig().stackedTeams).toEqual([BLUE]);
    const [red] = nationsOn(RED);
    const [blue] = nationsOn(BLUE);
    expect(game.config().difficultyFor(red)).toBe(Difficulty.Hard);
    expect(game.config().difficultyFor(blue)).toBe(Difficulty.Impossible);
    level(game, red, blue);
    // Impossible's troop cap is 1.25x Hard's.
    expect(game.config().maxTroops(blue) / game.config().maxTroops(red)).toBe(
      1.25,
    );
  });

  test("short-handed Impossible nations grow 10% faster", async () => {
    const { game, nationsOn } = await stackedGame(Difficulty.Impossible);
    const [red] = nationsOn(RED);
    const [blue] = nationsOn(BLUE);
    expect(game.config().difficultyFor(blue)).toBe(Difficulty.Impossible);
    level(game, red, blue);
    expect(game.config().maxTroops(blue)).toBe(game.config().maxTroops(red));
    expect(
      game.config().troopIncreaseRate(blue) /
        game.config().troopIncreaseRate(red),
    ).toBeCloseTo(1.1, 9);
  });

  test("the lobby preview deals the same nations and flags the same teams", async () => {
    const { game, humans, nationsOn } = await stackedGame(Difficulty.Hard);
    const preview = previewTeamNations(
      humans,
      resolveTeamsList(2, 12),
      2,
      10,
      Difficulty.Hard,
    );
    expect(preview.nations.get(RED)).toBe(nationsOn(RED).length);
    expect(preview.nations.get(BLUE)).toBe(nationsOn(BLUE).length);
    expect(preview.nations.get(RED)).toBe(2);
    expect(preview.stacked).toEqual(game.config().gameConfig().stackedTeams);
  });

  test("balanced humans: nobody plays harder", async () => {
    const humans = [human(0, 0), human(1, 1)];
    const nations = Array.from({ length: 6 }, (_, i) => nation(i));
    const game = await setup(
      "big_plains",
      { gameMode: GameMode.Team, playerTeams: 2, difficulty: Difficulty.Hard },
      [...humans, ...nations],
    );
    expect(game.config().gameConfig().stackedTeams ?? []).toEqual([]);
    for (const p of game.allPlayers()) {
      if (p.type() !== PlayerType.Nation) continue;
      expect(game.config().difficultyFor(p)).toBe(Difficulty.Hard);
    }
    const preview = previewTeamNations(
      humans,
      resolveTeamsList(2, 8),
      2,
      6,
      Difficulty.Hard,
    );
    expect(preview.stacked).toEqual([]);
    expect(preview.nations.get(RED)).toBe(3);
    expect(preview.nations.get(BLUE)).toBe(3);
  });
});
