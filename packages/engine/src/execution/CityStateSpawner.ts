import { TileRef } from "@openfront/engine-api/game/GameMap";
import {
  Cell,
  GameMapSize,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { type CustomTribe } from "@openfront/engine-api/game/Maps.gen";
import { GameID } from "@openfront/engine-api/Schemas";
import { resolveTribeNameData } from "@openfront/engine-lib/execution/utils/TribeNames";
import { terrainFeatureAllowsStructures } from "@openfront/engine-lib/game/TerrainFeatures";
import {
  CITY_STATE_MIN_DISTANCE,
  CITY_STATE_MIN_LAND_PERCENT,
  CITY_STATE_NAMES,
  CITY_STATE_PLACEMENT_TRIES,
  CITY_STATE_RADIUS,
  cityStateCount,
} from "@openfront/engine-lib/game/WorldFeatures";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { simpleHash } from "@openfront/engine-lib/Util";
import { Game } from "../game/Game";
import { humanAndNationCount } from "../game/StartPlacements";
import { cityStateDisc, CityStateExecution } from "./CityStateExecution";

/** Seed offset from the game id, apart from the other game-seeded PRNGs. */
const CITY_STATE_SEED_OFFSET = 3;

/**
 * Picks where the city-states (engine-lib/game/WorldFeatures.ts) go, at game
 * start, and returns one CityStateExecution each. A map's static
 * custom_tribes entries come first: at their coordinates when they have
 * them, else at a random spot under their name. Random ones fill up to
 * cityStateCount() of the game's humans and nations: on passable land at
 * least CITY_STATE_MIN_DISTANCE from every nation spawn cell and from each
 * other, with mostly land around them.
 */
export class CityStateSpawner {
  private random: PseudoRandom;
  private nationTiles: TileRef[];

  constructor(
    private game: Game,
    gameID: GameID,
    nationCells: Cell[] = [],
    private customTribes: CustomTribe[] | undefined = resolveTribeNameData(
      game.config().gameConfig().gameMap,
    ).customTribes,
  ) {
    this.random = new PseudoRandom(simpleHash(gameID) + CITY_STATE_SEED_OFFSET);
    this.nationTiles = nationCells
      .filter((c) => game.isValidCoord(c.x, c.y))
      .map((c) => game.ref(c.x, c.y));
  }

  spawnCityStates(): CityStateExecution[] {
    const statics = (this.customTribes ?? []).filter(
      (ct) => ct.static === true,
    );
    const centers: TileRef[] = [];
    const execs: CityStateExecution[] = [];
    const named: string[] = [];

    // Hand-placed ones go exactly where the map says.
    for (const ct of statics) {
      if (ct.coordinates === undefined) {
        named.push(ct.name);
        continue;
      }
      const tile = this.staticTile(ct);
      if (tile === null) continue;
      centers.push(tile);
      execs.push(this.cityState(ct.name, tile));
    }

    const used = new Set(statics.map((ct) => ct.name));
    const names = [
      ...named,
      ...this.random.shuffleArray(CITY_STATE_NAMES.filter((n) => !used.has(n))),
    ];
    const target = Math.max(
      cityStateCount(humanAndNationCount(this.game)),
      execs.length + named.length,
    );
    const minDist2 = CITY_STATE_MIN_DISTANCE * CITY_STATE_MIN_DISTANCE;
    for (
      let i = 0;
      i < CITY_STATE_PLACEMENT_TRIES && execs.length < target;
      i++
    ) {
      const tile = this.game.ref(
        this.random.nextInt(0, this.game.width()),
        this.random.nextInt(0, this.game.height()),
      );
      if (
        !this.isFreeLand(tile) ||
        this.nationTiles.some(
          (t) => this.game.euclideanDistSquared(t, tile) < minDist2,
        ) ||
        centers.some(
          (t) => this.game.euclideanDistSquared(t, tile) < minDist2,
        ) ||
        !this.mostlyLand(tile)
      ) {
        continue;
      }
      centers.push(tile);
      execs.push(
        this.cityState(names.shift() ?? `City-state ${execs.length + 1}`, tile),
      );
    }
    return execs;
  }

  private cityState(name: string, center: TileRef): CityStateExecution {
    return new CityStateExecution(
      new PlayerInfo(name, PlayerType.Bot, null, this.random.nextID()),
      center,
    );
  }

  /** A static entry's tile (halved on compact maps), or null if unusable. */
  private staticTile(ct: CustomTribe): TileRef | null {
    const isCompact =
      this.game.config().gameConfig().gameMapSize === GameMapSize.Compact;
    const [cx, cy] = ct.coordinates!;
    const x = isCompact ? Math.floor(cx / 2) : cx;
    const y = isCompact ? Math.floor(cy / 2) : cy;
    if (!this.game.isValidCoord(x, y)) {
      console.warn(
        `[CityStateSpawner] City-state "${ct.name}" coordinates [${x},${y}] out of bounds`,
      );
      return null;
    }
    const tile = this.game.ref(x, y);
    if (!this.isFreeLand(tile)) {
      console.warn(
        `[CityStateSpawner] City-state "${ct.name}" tile [${x},${y}] is not free land`,
      );
      return null;
    }
    return tile;
  }

  // A center holds the city, so not a river or ford (terrain features).
  private isFreeLand(tile: TileRef): boolean {
    return (
      this.game.isLand(tile) &&
      !this.game.isImpassable(tile) &&
      !this.game.hasOwner(tile) &&
      terrainFeatureAllowsStructures(this.game.terrainFeature(tile))
    );
  }

  /** At least CITY_STATE_MIN_LAND_PERCENT of the disc is free land. */
  private mostlyLand(center: TileRef): boolean {
    const r = CITY_STATE_RADIUS;
    let disc = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) disc++;
      }
    }
    return (
      cityStateDisc(this.game, center).length * 100 >=
      disc * CITY_STATE_MIN_LAND_PERCENT
    );
  }
}
