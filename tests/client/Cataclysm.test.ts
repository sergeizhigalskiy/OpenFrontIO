import { UnitType } from "@openfront/engine-api/game/GameTypes";
import {
  GameUpdateType,
  RisingTideUpdate,
  VolcanoUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import {
  VOLCANO_ERUPTION_RADIUS,
  VOLCANO_WARNING_RADIUS,
} from "@openfront/engine-lib/game/Volcanoes";
import { formatCountdown } from "../../src/client/components/RisingTidePanel";
import { TELEGRAPH_ENEMY } from "../../src/client/render/frame/derive/NukeTelegraphs";
import { notableLobbySettings } from "../../src/client/utilities/LobbySettingsSummary";
import { translateText } from "../../src/client/Utils";
import {
  CataclysmView,
  eruptionFx,
  volcanoTelegraphs,
} from "../../src/client/view/CataclysmView";
import { testGameConfig } from "../util/Wire";

const MAP_W = 100;

function volcano(over: Partial<VolcanoUpdate> = {}): VolcanoUpdate {
  return {
    type: GameUpdateType.Cataclysm,
    kind: "volcano",
    sites: [205, 950],
    rumblingSite: null,
    eruptionTick: 0,
    eruptedSite: null,
    ...over,
  };
}

function tide(over: Partial<RisingTideUpdate> = {}): RisingTideUpdate {
  return {
    type: GameUpdateType.Cataclysm,
    kind: "tide",
    nextWaveTick: 4800,
    warningTiles: [],
    wave: 0,
    originalLand: 1000,
    ...over,
  };
}

describe("CataclysmView", () => {
  test("keeps the latest state of each kind, and eruptions for one tick", () => {
    const view = new CataclysmView();
    view.apply(undefined);
    expect(view.volcanoSites).toEqual([]);
    expect(view.tide).toBeNull();

    view.apply([volcano(), tide()]);
    expect(view.volcanoSites).toEqual([205, 950]);
    expect(view.tide?.nextWaveTick).toBe(4800);

    view.apply([
      volcano({ rumblingSite: 205, eruptionTick: 5000 }),
      tide({ warningTiles: [1, 2, 3] }),
    ]);
    expect(view.rumblingSite).toBe(205);
    expect(view.tide?.warningTiles).toEqual([1, 2, 3]);

    view.apply([volcano({ eruptedSite: 205 })]);
    expect(view.rumblingSite).toBeNull();
    expect(view.eruptedSites).toEqual([205]);
    // The tide state stays when only the volcano changed.
    expect(view.tide?.warningTiles).toEqual([1, 2, 3]);
    view.apply([]);
    expect(view.eruptedSites).toEqual([]);
  });

  test("keeps the Horde Night land record and outcome, apart from the tide", () => {
    const view = new CataclysmView();
    expect(view.horde).toBeNull();
    expect(view.hordeStartTiles(3)).toBeNull();
    view.apply([
      tide(),
      {
        type: GameUpdateType.Cataclysm,
        kind: "horde",
        startLand: [3, 400, 5, 120],
        outcome: null,
      },
    ]);
    expect(view.tide?.nextWaveTick).toBe(4800);
    expect(view.hordeStartTiles(3)).toBe(400);
    expect(view.hordeStartTiles(5)).toBe(120);
    expect(view.hordeStartTiles(4)).toBeNull();
    view.apply([
      {
        type: GameUpdateType.Cataclysm,
        kind: "horde",
        startLand: [3, 400, 5, 120],
        outcome: "narrow",
      },
    ]);
    expect(view.horde?.outcome).toBe("narrow");
    expect(view.tide?.nextWaveTick).toBe(4800);
  });

  test("a rumbling site draws as a hostile telegraph; an eruption as a nuke blast", () => {
    const view = new CataclysmView();
    view.apply([volcano()]);
    expect(volcanoTelegraphs(view, MAP_W)).toEqual([]);
    view.apply([volcano({ rumblingSite: 205, eruptionTick: 5000 })]);
    expect(volcanoTelegraphs(view, MAP_W)).toEqual([
      {
        x: 5,
        y: 2,
        innerRadius: VOLCANO_ERUPTION_RADIUS,
        outerRadius: VOLCANO_WARNING_RADIUS,
        relation: TELEGRAPH_ENEMY,
      },
    ]);
    expect(eruptionFx(view)).toEqual([]);
    view.apply([volcano({ eruptedSite: 205 })]);
    expect(eruptionFx(view)).toEqual([
      {
        unitType: UnitType.AtomBomb,
        pos: 205,
        reachedTarget: true,
        ownerSmallID: 0,
      },
    ]);
  });
});

describe("rising tide countdown", () => {
  test("m:ss", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(180)).toBe("3:00");
    expect(formatCountdown(-3)).toBe("0:00");
  });
});

describe("lobby summary", () => {
  test("lists volcanoes and rising tide only when on", () => {
    const labels = (c: Parameters<typeof notableLobbySettings>[0]) =>
      notableLobbySettings(c, null).map((i) => i.label);
    const volcanoes = translateText("game_settings.volcanoes");
    const risingTide = translateText("game_settings.rising_tide");
    const off = labels(testGameConfig());
    expect(off).not.toContain(volcanoes);
    expect(off).not.toContain(risingTide);
    const on = labels(testGameConfig({ volcanoes: true, risingTide: true }));
    expect(on).toContain(volcanoes);
    expect(on).toContain(risingTide);
  });
});
