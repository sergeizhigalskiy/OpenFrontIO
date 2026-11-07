import { GameMapType } from "@openfront/engine-api/game/Maps.gen";

/**
 * Where the Protected State's nation (PROTECTED_STATE_NATION in
 * ProtectedState.ts) spawns on a map whose manifest leaves it out.
 *
 * With the mode on, the named nation always spawns: NationCreation keeps it
 * when the game draws a random subset of the map's nations, and adds it when
 * the map has no nation by that name, at its spot here (full-size map tiles;
 * compact maps halve them) or, on a map not listed, wherever the spawn rules
 * put a nation without a spot.
 *
 * Keys are nation names in lower case. Add a nation, or a map for one, by
 * finding a land tile inside its borders on that map.
 */
export interface ExtraNationSpawn {
  /** Flag code, as in the map manifests ("il"), or null for none. */
  flag: string | null;
  /** Spawn tile per map, full-size coordinates. */
  spawns: Partial<Record<GameMapType, [number, number]>>;
}

export const PROTECTED_STATE_EXTRA_NATIONS: Record<string, ExtraNationSpawn> = {
  israel: {
    flag: "il",
    spawns: {
      [GameMapType.World]: [1131, 316],
      [GameMapType.GiantWorldMap]: [2336, 626],
      [GameMapType.Asia]: [113, 704],
    },
  },
};
