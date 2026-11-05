// Renderer types (units, players, tiles, names, config)
export {
  DEFAULT_NUKE_EXPLOSION_COLOR,
  MAX_NUKE_EXPLOSION_COLORS,
  PlayerTypeEnum,
  TrainType,
} from "./Renderer";
export type {
  AllianceData,
  AttackData,
  AttackRingInput,
  ConquestFx,
  DeadUnitFx,
  EmojiData,
  GhostPreviewData,
  NameEntry,
  NukeExplosionRenderParams,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "./Renderer";

// Frame data — boundary contract between game integration and features
export type { FrameData } from "./FrameData";

// Frame events — per-frame ephemeral events (rendering FX)
export type { BonusEvent, FrameEvents } from "./FrameEvents";

// Unit type string constants and derived sets
export {
  ALL_UNIT_TYPES,
  NUKE_MAGNITUDES,
  NUKE_TYPES,
  SMOOTHED_NUKE_TYPES,
  STRUCTURE_TYPES,
  TRAIL_TYPES,
  UT_AIRBASE,
  UT_AIRDROP,
  UT_AIRSTRIKE,
  UT_ATOM_BOMB,
  UT_BALLISTIC_MISSILE,
  UT_CITY,
  UT_CLUSTER_MISSILE,
  UT_CLUSTER_WARHEAD,
  UT_COASTAL_BATTERY,
  UT_CONVOY,
  UT_CRUISE_MISSILE,
  UT_DEFENSE_POST,
  UT_DRONE,
  UT_FACTORY,
  UT_FLAK_GUN,
  UT_HYDROGEN_BOMB,
  UT_MINEFIELD,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_SIEGE_CAMP,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "./UnitType";
