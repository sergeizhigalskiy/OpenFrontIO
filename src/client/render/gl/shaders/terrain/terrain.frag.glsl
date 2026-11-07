#version 300 es
precision highp float;
precision highp usampler2D;
precision highp sampler2DArray;

// The map surface: textured, lit land in biomes; water with depth, waves,
// fresnel, sun glint and shore foam; forests, rivers and fords. See
// TerrainPass.ts.
//
// Land and water meet on a smooth coast: the zero line of the climate
// field's signed coast distance (ClimateData.ts), which follows the tiles
// without their stair steps. The territory and border shaders use the same
// line. Impassable walls stay per tile.
//
// Light: one sun from the top-left of the screen (SceneLight.ts), soft
// shadows and sky openness baked from the relief heights (ReliefBake.ts),
// surface normals from the relief heights plus the ground detail textures
// (DetailTextures.ts). Flat open ground in full sun keeps its palette
// colour, so territory colours drawn over it read as before.
//
// QUALITY (define): 0 low (no detail textures, calm water), 1 medium,
// 2 high (detail normals and a second detail scale, two wave layers).

#include "camera"
// Sun, baked shadows, sky openness, relief normals and the smooth coast
// (uShadow, uRelief, uClimate: coast distance, moisture, cold, variation).
#include "terrain-light"

uniform usampler2D uTerrainBytes; // R8UI: bit 7 land, bits 0-4 magnitude
uniform sampler2D uSurface;       // RGBA8: depth, coast, wall, elevation
uniform usampler2D uFeatures;     // R8UI: packTerrainFeatures
uniform sampler2D uNoise;         // RG8 tileable: smooth noise, crowns
uniform sampler2DArray uDetail;   // ground detail layers (DETAIL_*)
uniform int uHasFeatures;

uniform vec3 uBackground; // impassable terrain (matches the clear colour)
uniform vec3 uOcean;      // open water; shallows and deeps derive from it
uniform vec3 uSand;
uniform vec3 uPlains;
uniform vec3 uHighland;
uniform vec3 uMountain;   // the highest peaks (snow); lower slopes are rock

uniform float uShadeStrength; // relief lighting, 0 = flat (hillshade off)
uniform float uWinter;        // 0-1: winter snow on the snow band
uniform float uSnowRows;      // tile rows of the snow band (from the top)
// World-feature sites drawn into the ground (TerrainPass.setSites): xy the
// site tile, z the kind (0 ruin, 1 volcano), w 1 while a volcano rumbles.
uniform vec4 uSites[MAX_SITES];
uniform int uSiteCount;
uniform float uTime;          // seconds, wraps every TIME_PERIOD

in vec2 vTile;
in vec3 vWorld;
in vec2 vDepth;
out vec4 fragColor;

const vec2 MAP_SIZE = vec2(float(MAP_W), float(MAP_H));
// Encodings, mirrored from gl/terrain/SurfaceData.ts and ClimateData.ts.
const float WATER_DEPTH_RANGE = 64.0;
const float COAST_UNITS = 32.0;
const float WALL_UNITS = 8.0;
const float ELEVATION_UNITS = 8.0;
// gl/terrain/TerrainNoise.ts: texels per repeat, texels per crown.
const float NOISE_SIZE = 64.0;
const float CROWN_CELL = 8.0;
// uTime wraps every TIME_PERIOD seconds; every motion below completes a
// whole number of cycles in that time, so the wrap is seamless.
const float TIME_PERIOD = 600.0;
const float TAU = 6.28318531;
// World tiles of height per uHeightMap unit at a height scale of one tile a
// level (255 / HEIGHT_UNITS_PER_LEVEL).
const float UNITS_PER_LEVEL_SCALE = 36.4286;

// Detail layers (terrain/DetailTextures.ts).
const float DETAIL_GRASS = 0.0;
const float DETAIL_DRY = 1.0;
const float DETAIL_SAND = 2.0;
const float DETAIL_ROCK = 3.0;
const float DETAIL_SNOW = 4.0;
const float DETAIL_TUNDRA = 5.0;
const float DETAIL_DIRT = 6.0;
const float DETAIL_WATER = 7.0;

const vec3 FOAM = vec3(0.93, 0.97, 0.98);
const vec3 HAZE = vec3(0.74, 0.80, 0.86);
const vec3 SKY_ZENITH = vec3(0.50, 0.68, 0.88);
const vec3 SKY_HORIZON = vec3(0.86, 0.91, 0.95);
// Tiles per screen pixel along the longer axis of a pixel's footprint, for
// anti-aliasing and mip levels.
float gPx;
// Tiles per pixel across the footprint's area (its geometric mean): what
// detail fades by. The isometric view foreshortens the ground, so this is
// smaller than gPx there.
float gArea;
// Screen derivatives of the tile position (texture gradients in branches).
vec2 gDx;
vec2 gDy;
// Fade of the ground detail: 1 up close, 0 when a tile is a pixel or less.
float gDetail;

float waterDepth(float r) { return r * r * WATER_DEPTH_RANGE; }
float coastDistance(float g) { return g * 255.0 / COAST_UNITS; }
float wallDistance(float b) { return (b * 255.0 - 128.0) / WALL_UNITS; }
float elevationLevel(float a) { return a * 255.0 / ELEVATION_UNITS; }

// The noise texture stretched over `tilesPer` tiles, with its mip level
// picked from gPx (explicit, since this runs in non-uniform control flow).
vec2 noiseAt(vec2 p, float tilesPer) {
  float lod = log2(max(gPx * NOISE_SIZE / tilesPer, 1e-3));
  return textureLod(uNoise, p / tilesPer, lod).rg;
}

// A detail layer stretched over `tiles` tiles per repeat.
vec4 detailAt(float layer, vec2 p, float tiles) {
  return textureGrad(uDetail, vec3(p / tiles, layer), gDx / tiles, gDy / tiles);
}

// Speed for `cycles` whole repeats per TIME_PERIOD.
float cyclesPerPeriod(float cycles) { return cycles / TIME_PERIOD; }

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// ---------------------------------------------------------------------------
// Light
// ---------------------------------------------------------------------------

// Light with the hillshade setting's strength (terrain-light lightAt).
float terrainLight(vec3 n, float sun, float sky) {
  return lightAt(n, sun, sky, uShadeStrength);
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

// uOcean is the open sea a few tiles out: lighter and greener in the
// shallows, darker and bluer over the deeps.
vec3 waterColor(float depth) {
  vec3 shallow = mix(uOcean, vec3(0.45, 0.80, 0.80), 0.42);
  vec3 deep = uOcean * vec3(0.55, 0.68, 0.82);
  vec3 c = mix(shallow, uOcean, smoothstep(0.0, 5.0, depth));
  return mix(c, deep, smoothstep(4.0, 26.0, depth));
}

// Unit vector from the surface toward the eye.
vec3 viewDir() {
  if (uCamUp.w > 0.0) return normalize(uCamEye.xyz - vWorld);
  return -uCamForward.xyz;
}

// Wave normal: drifting layers of the water detail, calming to flat as the
// map zooms out. `crest` returns where the waves break white.
vec3 waveNormal(vec2 p, float calm, out float crest) {
  crest = 0.0;
#if QUALITY >= 1
  if (gDetail <= 0.0) return vec3(0.0, 0.0, 1.0);
  float t = uTime;
  const float SCALE1 = 9.0;
  vec2 drift1 = vec2(cyclesPerPeriod(30.0), cyclesPerPeriod(18.0)) * t * SCALE1;
  vec4 a = detailAt(DETAIL_WATER, p + drift1, SCALE1);
  vec2 n = a.gb * 2.0 - 1.0;
  crest = a.a;
#if QUALITY >= 2
  const float SCALE2 = 5.3;
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;
  vec2 drift2 = vec2(-cyclesPerPeriod(26.0), cyclesPerPeriod(34.0)) * t * SCALE2;
  vec4 b = detailAt(DETAIL_WATER, q + drift2, SCALE2);
  n = n * 0.6 + (b.gb * 2.0 - 1.0) * 0.5;
  crest = max(crest, b.a) * 0.8;
#endif
  float strength = 0.4 * gDetail * calm;
  return normalize(vec3(n * strength, 1.0));
#else
  return vec3(0.0, 0.0, 1.0);
#endif
}

// Water at depth `depth` (tiles from shore), `shore` tiles out from the
// smooth coastline (0 at it), lit by the sun.
vec3 shadeWater(vec2 p, float depth, float shore, float sun) {
  vec3 c = waterColor(depth);
  // Slow broad brightness drift, so open water isn't flat paint.
  float t = uTime;
  vec2 a = p / 61.0 + vec2(cyclesPerPeriod(10.0), cyclesPerPeriod(6.0)) * t;
  float swell = textureLod(uNoise, a, log2(max(gPx * NOISE_SIZE / 61.0, 1e-3))).r;
  c *= 0.96 + 0.08 * swell;

  float crest;
  // Rough in open water, calmer in the shallows.
  vec3 n = waveNormal(p, 0.6 + 0.4 * smoothstep(0.0, 4.0, depth), crest);
  vec3 v = viewDir();
  c *= mix(1.0, 0.72 + 0.28 * sun, uShadeStrength);
  // The wave faces turned to the sun lighter, the far faces darker.
  float faces = (dot(n, uLightDir) - uLightDir.z) / max(uLightDir.z, 0.2);
  c *= 1.0 + 0.55 * faces * uShadeStrength;

  if (uShadeStrength > 0.0) {
    // Sky reflected at grazing angles.
    vec3 r = reflect(-v, n);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    vec3 sky = mix(SKY_HORIZON, SKY_ZENITH, clamp(r.z, 0.0, 1.0));
    c = mix(c, sky, clamp(fres * 0.6, 0.0, 0.35));
    // Sun glint: a broad sheen and sharp sparkles off the wave faces.
    vec3 h = normalize(uLightDir + v);
    float nh = max(dot(n, h), 0.0);
    float glint = 0.07 * pow(nh, 40.0) + 0.9 * pow(nh, 900.0);
    c += vec3(1.0, 0.97, 0.88) * glint * sun * gDetail;
  }

  // Shallows near the shore: lighter, with wet sand showing through.
  float shelf = 1.0 - smoothstep(0.0, 1.4, shore);
  c = mix(c, mix(c, uSand * 0.92, 0.35), shelf * 0.55);

  // Foam along the shore, lapping in and out, broken up by the waves.
  float lap = sin(TAU * cyclesPerPeriod(110.0) * t + swell * 6.0);
  float width = max(0.32 + 0.1 * lap, 1.1 * gPx);
  float foam = 1.0 - smoothstep(0.0, width, shore);
  float band = (1.0 - smoothstep(0.0, 0.55, abs(shore - (0.55 + 0.12 * lap))));
  foam = max(foam * 0.8, band * 0.45 * (0.6 + 0.4 * crest) * gDetail);
  // White caps on open water, up close.
  foam = max(foam, crest * 0.12 * gDetail * smoothstep(3.0, 10.0, depth));
  return mix(c, FOAM, clamp(foam, 0.0, 1.0) * 0.75);
}

// ---------------------------------------------------------------------------
// Land
// ---------------------------------------------------------------------------

uint featureAt(ivec2 t) {
  t = clamp(t, ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  return texelFetch(uFeatures, t, 0).r & 3u;
}

float forestAt(ivec2 t) {
  return featureAt(t) == 1u ? 1.0 : 0.0;
}

// Ground mix: weights of the biomes at a point.
struct Biomes {
  float grass;
  float dry;
  float sand;
  float rock;
  float snow;
  float tundra;
  float dirt;
};

Biomes biomesAt(float level, float slope, float moisture, float cold,
                float coast, float winter, float jitter) {
  Biomes b;
  // Snow: the highest ground (lower where it is cold), and winter snow over
  // the snow band. Steep faces shed it.
  float line = 27.0 - 9.0 * cold + 1.6 * jitter;
  float snow = smoothstep(line, line + 1.6, level);
  snow *= 1.0 - 0.75 * smoothstep(0.9, 1.8, slope);
  snow = max(snow, winter * (1.0 - 0.45 * smoothstep(1.2, 2.2, slope)));
  // Bare rock: steep ground, and the high mountains below the snow.
  float rock = max(
    smoothstep(0.9, 1.9, slope) * smoothstep(6.0, 14.0, level),
    smoothstep(20.5, 25.5, level + 1.5 * jitter)
  );
  rock *= 1.0 - snow;
  float open = (1.0 - snow) * (1.0 - rock);
  // The cold north: tundra.
  float tundra = open * smoothstep(0.25, 0.85, cold + 0.15 * jitter);
  open -= tundra;
  // The map's own elevation bands lead, as its palette did: grass on the
  // lowlands, dry grass above them, dirt and scrub on the highlands.
  // Moisture only nudges them (wet ground stays green a little higher up),
  // and the driest highlands turn to desert sand.
  float m = moisture + 0.1 * jitter;
  float lift = level + 1.5 * jitter + 2.5 * (0.5 - m);
  float lowland = 1.0 - smoothstep(4.5, 9.0, lift);
  float upland = open * (1.0 - lowland);
  float highland = smoothstep(9.5, 13.5, level + 1.2 * jitter);
  float grass = open * lowland;
  float dry = upland * (1.0 - highland);
  float dirt = upland * highland;
  float desert = (1.0 - smoothstep(0.06, 0.24, m));
  float beach = (1.0 - smoothstep(0.35, 1.1, coast)) *
    (1.0 - smoothstep(5.0, 11.0, level));
  b.sand = (grass * 0.8 + dry) * beach + dirt * desert * 0.8;
  b.grass = grass * (1.0 - 0.8 * beach);
  b.dry = dry * (1.0 - beach);
  b.dirt = dirt * (1.0 - desert * 0.8);
  b.rock = rock;
  b.snow = snow;
  b.tundra = tundra;
  return b;
}

// Base colours of the biomes, from the palette.
vec3 grassColor() {
  vec3 c = uPlains * vec3(0.80, 0.90, 0.70);
  return mix(c, vec3(luma(c)), 0.18);
}
vec3 dryColor() { return mix(uPlains, uHighland, 0.6) * vec3(1.0, 0.96, 0.80); }
vec3 desertColor() { return mix(uSand, uHighland, 0.3) * vec3(1.02, 0.97, 0.88); }
vec3 dirtColor() { return uHighland * vec3(0.84, 0.77, 0.64); }
vec3 rockColor() {
  return mix(uHighland, vec3(luma(uHighland)), 0.6) * vec3(0.80, 0.78, 0.76);
}
vec3 tundraColor() {
  vec3 c = mix(uPlains, vec3(0.62, 0.60, 0.52), 0.55) * vec3(0.86, 0.88, 0.80);
  return mix(c, vec3(luma(c)), 0.2);
}

// Add one biome's textured colour into the running mix.
void addBiome(inout vec4 acc, inout vec3 nAcc, float w, vec3 base,
              float layer, vec2 p, float tiles) {
  if (w <= 0.004) return;
  float alb = 1.0;
  vec2 dn = vec2(0.0);
  float hgt = 0.5;
#if QUALITY >= 1
  if (gDetail > 0.0) {
    vec4 d = detailAt(layer, p, tiles);
#if QUALITY >= 2
    // A second, larger scale hides the repeat.
    vec4 d2 = detailAt(layer, mat2(0.6, 0.8, -0.8, 0.6) * p + 13.7, tiles * 3.7);
    d = mix(d, d2, 0.38);
#endif
    alb = mix(1.0, d.r * 2.0, gDetail);
    dn = (d.gb * 2.0 - 1.0) * gDetail;
    hgt = d.a;
  }
#endif
  // Height-weighted blend: where grounds meet, the taller detail wins.
  float hw = w * (0.35 + hgt);
  acc += vec4(base * alb * hw, hw);
  nAcc += vec3(dn * hw, 0.0);
}

// Forest canopy over the ground: clustered crowns, each a lit dome with a
// shadowed side, dark gaps between them, ragged edges. Returns the lit
// canopy colour; `cover` its coverage. The ground beside the woods takes
// their shadow through `groundShade`.
vec3 forestCanopy(vec2 p, float sunVis, float sky, out float cover,
                  inout float groundShade) {
  cover = 0.0;
  vec2 g = p - 0.5;
  ivec2 b = ivec2(floor(g));
  vec2 f = g - vec2(b);
  float f00 = forestAt(b);
  float f10 = forestAt(b + ivec2(1, 0));
  float f01 = forestAt(b + ivec2(0, 1));
  float f11 = forestAt(b + ivec2(1, 1));
  float m = mix(mix(f00, f10, f.x), mix(f01, f11, f.x), f.y);
  if (m <= 0.0) return vec3(0.0);
  vec2 dm = vec2(mix(f10 - f00, f11 - f01, f.y), mix(f01 - f00, f11 - f10, f.x));
  vec2 lightXY = normalize(uLightDir.xy + 1e-5);

  // Crowns at two sizes, so the canopy clusters instead of tiling. Full
  // detail from about 8 pixels a tile; below 3 the woods are a smooth tone.
  float detail = 1.0 - smoothstep(0.12, 0.33, gArea);
  float big = NOISE_SIZE / CROWN_CELL * 1.5;
  float small = NOISE_SIZE / CROWN_CELL * 0.85;
  vec2 q = p + vec2(3.7, 1.3);
  float crown = max(noiseAt(p, big).g, 0.9 * noiseAt(q, small).g);
  // Dome normal from the slope of the crown height.
  const float E = 0.12;
  float cx = max(noiseAt(p + vec2(E, 0.0), big).g, 0.9 * noiseAt(q + vec2(E, 0.0), small).g);
  float cy = max(noiseAt(p + vec2(0.0, E), big).g, 0.9 * noiseAt(q + vec2(0.0, E), small).g);
  vec3 cn = normalize(vec3(
    -(cx - crown) / E * 0.55 * detail,
    -(cy - crown) / E * 0.55 * detail,
    1.0
  ));
  float grove = noiseAt(p, 21.0).r;

  float edge = m + (crown - 0.5) * 0.45 * detail;
  float aa = max(0.7 * gPx, 0.04);
  cover = smoothstep(0.5 - aa, 0.5 + aa, edge);

  vec3 base = mix(uPlains, vec3(0.14, 0.27, 0.12), 0.68);
  base *= 0.88 + 0.24 * grove;
  // Gaps between crowns sit in shade.
  float gap = mix(1.0, 0.62 + 0.38 * smoothstep(0.1, 0.6, crown), detail);
  vec3 canopy = applyLight(base * gap, terrainLight(cn, sunVis, sky * gap));
  // The rim of the woods facing the light catches it; the far rim is dark.
  float rim = clamp(dot(-dm, lightXY), -1.0, 1.0);
  canopy *= 1.0 + 0.1 * rim * (1.0 - smoothstep(0.5, 1.0, m));

  // Shadow the woods cast on open ground beside them, away from the light.
  float shadowed = (1.0 - cover) * smoothstep(0.1, 0.5, m) *
    clamp(dot(normalize(dm + 1e-5), lightXY), 0.0, 1.0);
  groundShade *= 1.0 - 0.32 * shadowed;
  return canopy;
}

// Rivers and fords over the lit ground. Waterway coverage is a smooth
// weighted vote of the 3x3 tiles around the point, so channels run smooth,
// diagonal steps stay joined, and wide rivers have no seams inside.
vec3 waterways(vec2 p, ivec2 tile, vec3 ground, float sun) {
  float total = 0.0;
  float river = 0.0;
  float ford = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 q = tile + ivec2(i, j);
      vec2 d = p - (vec2(q) + 0.5);
      float w = max(0.0, 1.0 - dot(d, d) / 2.25);
      w *= w;
      uint f = featureAt(q);
      total += w;
      if (f >= 2u) river += w;
      if (f == 3u) ford += w;
    }
  }
  river /= total;
  if (river <= 0.0) return ground;
  ford /= total;
  float aa = max(0.8 * gPx, 0.03);
  const float EDGE = 0.42;
  float inWater = smoothstep(EDGE - aa, EDGE + aa, river);
  float isFord = smoothstep(0.35, 0.65, ford / max(river, 1e-3));

  // River water: the sea's shading, shallow, a touch darker along the banks.
  float mid = clamp((river - EDGE) * 2.5, 0.0, 1.0);
  vec3 water = shadeWater(p, 1.6 + 2.0 * mid, 9.0, sun);
  water *= 1.0 - 0.12 * (1.0 - smoothstep(EDGE, 0.85, river));

  // Ford: a pale sandy shoal, plainly shallower than the river, with
  // ripples drifting where the water runs fast over it (up close).
  vec3 shoal = mix(waterColor(0.0), uSand, 0.45);
  const float RIPPLE_TILES = 7.0;
  vec2 drift = vec2(RIPPLE_TILES * cyclesPerPeriod(24.0) * uTime);
  float ripple = abs(fract(noiseAt(p + drift, RIPPLE_TILES).r * 5.0) - 0.5);
  float rippleDetail = 1.0 - smoothstep(0.15, 0.35, gArea);
  shoal = mix(shoal, FOAM, 0.5 * smoothstep(0.36, 0.47, ripple) * rippleDetail);
  water = mix(water, shoal, isFord);

  // A thin damp bank just outside the water.
  float bank = smoothstep(EDGE - 0.2, EDGE, river) * (1.0 - inWater);
  vec3 c = mix(ground, ground * vec3(0.78, 0.8, 0.74), 0.7 * bank);
  return mix(c, water, inWater);
}

// ---------------------------------------------------------------------------
// World-feature sites
// ---------------------------------------------------------------------------

float sdBox(vec2 q, vec2 b) {
  vec2 d = abs(q) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float siteHash(vec2 s) {
  return fract(sin(dot(s, vec2(12.9898, 78.233))) * 43758.5453);
}

// Ruins and volcanoes in the ground itself, under their map icons: the
// ruins as pale paving and broken wall footings, a volcano as a dark ash
// cone (its slope lit like one) with a crater that glows while it rumbles.
// `glow` is light the lava gives off, added after shading.
void applySites(vec2 p, inout vec3 albedo, inout vec3 n, out vec3 glow) {
  glow = vec3(0.0);
  for (int i = 0; i < MAX_SITES; i++) {
    if (i >= uSiteCount) break;
    vec4 site = uSites[i];
    vec2 d = p - (site.xy + 0.5);
    float r = length(d);
    if (site.z < 0.5) {
      if (r > 3.0) continue;
      // Ruins: a slab of paving with the footings of two buildings on it.
      float a = siteHash(site.xy) * 6.2832;
      vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
      float paving = 1.0 - smoothstep(1.7, 2.6, r + 0.6 * (noiseAt(p, 3.0).r - 0.5));
      float walls = min(
        abs(sdBox(q - vec2(-0.35, 0.1), vec2(0.95, 0.65))),
        abs(sdBox(q - vec2(0.85, -0.55), vec2(0.45, 0.4)))
      );
      float broken = step(0.42, noiseAt(q * 1.7 + site.xy, 2.0).r);
      float wall = (1.0 - smoothstep(0.08, 0.16, walls)) * broken;
      vec3 stone = vec3(0.80, 0.76, 0.66);
      albedo = mix(albedo, stone * (0.86 + 0.2 * noiseAt(p, 1.5).r), paving * 0.5);
      albedo = mix(albedo, stone * 1.05, wall);
      continue;
    }
    if (r > 8.0) continue;
    // Volcano: an ash cone. The slope pushes the normal outward.
    float cone = 1.0 - smoothstep(1.2, 7.5, r);
    vec2 out2 = d / max(r, 1e-3);
    float slope = 0.9 * cone * smoothstep(0.8, 1.6, r);
    n = normalize(n + vec3(out2 * slope, 0.0));
    vec3 ash = vec3(0.24, 0.22, 0.21) * (0.85 + 0.3 * noiseAt(p, 2.0).r);
    albedo = mix(albedo, ash, (1.0 - smoothstep(3.0, 7.5, r)));
    // The crater: a dark bowl inside a rim.
    float crater = 1.0 - smoothstep(0.8, 1.2, r);
    albedo = mix(albedo, vec3(0.1, 0.09, 0.09), crater);
    float pulse = 0.55 + 0.45 * sin(uTime * 3.0 + site.x);
    float hot = mix(0.35, pulse, site.w);
    glow += vec3(1.0, 0.38, 0.08) * crater * hot * (0.6 + 0.4 * noiseAt(p, 0.9).r);
    // Lava seams running down the flanks while it rumbles.
    float seams = smoothstep(0.86, 0.97, noiseAt(vec2(atan(d.y, d.x) * 3.0, r * 0.25), 1.0).r);
    glow += vec3(1.0, 0.3, 0.05) * seams * site.w * cone * 0.5;
  }
}

vec3 shadeLand(vec2 p, ivec2 tile, vec4 sf, vec4 climate, float sun,
               float sky) {
  // Relief normal: under a tile apart up close, wider when zoomed out so the
  // light shows landforms instead of per-tile speckle.
  float k = clamp(1.2 * gPx, 0.75, 6.0);
  vec3 n = reliefNormal(p, k, 1.0 / MAP_SIZE);
  // Slope in elevation levels per tile, whatever the height scale.
  float levelTiles = max(uHeightTiles / UNITS_PER_LEVEL_SCALE, 0.05);
  float slope = length(n.xy) / max(n.z, 1e-3) / levelTiles;
  float level = elevationLevel(sf.a);
  float coast = coastDistance(sf.g);
  float jitter = (noiseAt(p, 29.0).r - 0.5) * 2.0;
  float winter = uWinter * (1.0 - smoothstep(uSnowRows - 3.0, uSnowRows + 1.0, p.y));
  Biomes b = biomesAt(level, slope, climate.g, climate.b, coast, winter, jitter);

  vec4 acc = vec4(0.0);
  vec3 nAcc = vec3(0.0);
  // Tiles per texture repeat: about a texel a pixel at the closest zoom,
  // so grain shows up close and averages out further away.
  addBiome(acc, nAcc, b.grass, grassColor(), DETAIL_GRASS, p, 11.0);
  addBiome(acc, nAcc, b.dry, dryColor(), DETAIL_DRY, p, 11.0);
  addBiome(acc, nAcc, b.sand, desertColor(), DETAIL_SAND, p, 13.0);
  addBiome(acc, nAcc, b.dirt, dirtColor(), DETAIL_DIRT, p, 10.0);
  addBiome(acc, nAcc, b.rock, rockColor(), DETAIL_ROCK, p, 9.0);
  addBiome(acc, nAcc, b.tundra, tundraColor(), DETAIL_TUNDRA, p, 10.0);
  addBiome(acc, nAcc, b.snow, uMountain, DETAIL_SNOW, p, 15.0);
  vec3 albedo = acc.rgb / max(acc.a, 1e-4);
  // Broad variation, so wide plains and deserts aren't one flat colour,
  // and patches of lusher and drier ground a few tiles across.
  albedo *= 0.9 + 0.2 * climate.a;
  float patches = noiseAt(p + vec2(17.0, 5.0), 9.0).r;
  albedo *= mix(vec3(0.9, 0.95, 0.84), vec3(1.07, 1.04, 0.98), patches);

#if QUALITY >= 2
  // Ground detail bends the light too.
  n = normalize(n + vec3(nAcc.xy / max(acc.a, 1e-4) * 0.55, 0.0));
#endif
  vec3 glow = vec3(0.0);
  if (uSiteCount > 0) applySites(p, albedo, n, glow);

  uint packed = uHasFeatures != 0 ? texelFetch(uFeatures, tile, 0).r : 0u;
  float groundShade = 1.0;
  float cover = 0.0;
  vec3 canopy = vec3(0.0);
  if ((packed & 0x08u) != 0u) {
    canopy = forestCanopy(p, sun, sky, cover, groundShade);
  }

  float light = terrainLight(n, sun * groundShade, sky);
  // The ground beside impassable walls falls into their shadow.
  light *= mix(0.55, 1.0, smoothstep(0.0, 2.5, wallDistance(sf.b)));
  vec3 c = applyLight(albedo, light);
  c = mix(c, canopy, cover);
  c += glow;

  if ((packed & 0x04u) != 0u) c = waterways(p, tile, c, sun);
  return c;
}

// Impassable terrain: the map background, darkening into a lip where it
// meets the ground so walls read as sheer drops. Deeper in it is exactly the
// background, so impassable map borders still blend with the clear colour.
vec3 shadeWall(float wallDist) {
  float depth = -wallDist;
  float lip = 1.0 - smoothstep(0.0, max(0.6, 1.5 * gPx), depth);
  return uBackground * (1.0 - 0.3 * lip);
}

// Gentle grade over the surface: a little more colour and contrast.
vec3 grade(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float l = luma(c);
  c = clamp(mix(vec3(l), c, 1.02), 0.0, 1.0);
  return mix(c, c * c * (3.0 - 2.0 * c), 0.12);
}

void main() {
  vec2 p = vTile;
  gDx = dFdx(p);
  gDy = dFdy(p);
  float lx = length(gDx);
  float ly = length(gDy);
  gPx = max(lx, ly);
  gArea = sqrt(lx * ly);
  gDetail = 1.0 - smoothstep(0.2, 0.6, gArea);
  ivec2 tile = clamp(ivec2(floor(p)), ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  uint tb = texelFetch(uTerrainBytes, tile, 0).r;
  vec2 uv = p / MAP_SIZE;
  vec4 sf = texture(uSurface, uv);
  vec4 climate = texture(uClimate, uv);

  bool wall = (tb & 0x80u) != 0u && (tb & 0x1fu) == 31u;
  vec3 c;
  if (wall) {
    c = shadeWall(wallDistance(sf.b));
  } else {
    float sun = sunVisibility(uv);
    float sky = skyOpenness(uv);
    // The smooth coast: positive on land.
    float s = coastSdfAt(uv);
    float aa = max(0.6 * gPx, 0.02);
    float landMask = smoothstep(-aa, aa, s);
    vec3 land = vec3(0.0);
    vec3 water = vec3(0.0);
    if (landMask > 0.0) land = shadeLand(p, tile, sf, climate, sun, sky);
    if (landMask < 1.0) water = shadeWater(p, waterDepth(sf.r), max(-s, 0.0), sun);
    c = mix(water, land, landMask);
  }
  c = grade(c);

  // Tilted perspective cameras: distant ground fades into a light haze (not
  // walls, which stay the background colour).
  if (vDepth.y > 0.0 && !wall) {
    float haze = smoothstep(vDepth.y * 1.1, vDepth.y * 3.0, vDepth.x);
    c = mix(c, HAZE, 0.22 * haze);
  }
  fragColor = vec4(c, 1.0);
}
