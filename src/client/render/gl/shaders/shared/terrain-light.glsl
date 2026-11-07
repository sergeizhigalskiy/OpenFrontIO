// Shared terrain light and coast — expanded in place of
// `#include "terrain-light"` by createProgram, after `#include "camera"`
// (it reads the relief heights, uHeightMap, from there). The terrain,
// territory and border shaders use it so the fill and the lines on top of
// the ground take the same light and meet the same coast as the ground.
//
// Uniforms the pass fills from TerrainLighting (passes/TerrainPass.ts):
//   uShadow, uRelief       the relief bake (terrain/ReliefBake.ts)
//   uShadowW, uShadowFlat  which baked sun to read (terrain/SceneLight.ts)
//   uLightDir              toward the sun
//   uHeightTiles           world tiles of height per uHeightMap unit
//   uClimate               R: signed coast distance (terrain/ClimateData.ts)
uniform sampler2D uShadow;
uniform sampler2D uRelief;
uniform sampler2D uClimate;
uniform vec4 uShadowW;
uniform float uShadowFlat;
uniform vec3 uLightDir;
uniform float uHeightTiles;

// Share of the light that comes from the sun (the rest is sky): a shadow
// keeps 1 - SUN_SHARE of the light, so territory stays readable in it.
const float SUN_SHARE = 0.46;
// ClimateData.ts COAST_SDF_UNITS.
const float COAST_SDF_UNITS = 32.0;

// Relief height (world tiles) at a point; `invSize` = 1 / map size.
float reliefAt(vec2 p, vec2 invSize) {
  return textureLod(uHeightMap, p * invSize, 0.0).r * uHeightTiles;
}

// Surface normal of the relief, from heights k tiles either side.
vec3 reliefNormal(vec2 p, float k, vec2 invSize) {
  float l = reliefAt(p - vec2(k, 0.0), invSize);
  float r = reliefAt(p + vec2(k, 0.0), invSize);
  float u = reliefAt(p - vec2(0.0, k), invSize);
  float d = reliefAt(p + vec2(0.0, k), invSize);
  return normalize(vec3((l - r) / (2.0 * k), (u - d) / (2.0 * k), 1.0));
}

// Baked sun visibility (1 = in sun) for the current sun.
float sunVisibility(vec2 uv) {
  float iso = dot(texture(uShadow, uv), uShadowW);
  return iso + texture(uRelief, uv).g * uShadowFlat;
}

// Sky openness (1 = open ground, lower in valleys).
float skyOpenness(vec2 uv) {
  return texture(uRelief, uv).r;
}

// Light reaching a surface with normal n: sun (with its shadow) plus sky
// (with its openness), scaled so flat open ground in sun is exactly 1, and
// blended toward 1 by `strength` (0 = flat).
float lightAt(vec3 n, float sun, float sky, float strength) {
  if (strength <= 0.0) return 1.0;
  float flatSun = max(uLightDir.z, 0.2);
  float direct = max(dot(n, uLightDir), 0.0) / flatSun * sun;
  float ambient = sky * (0.72 + 0.28 * n.z);
  float light = SUN_SHARE * direct + (1.0 - SUN_SHARE) * ambient;
  return mix(1.0, light, strength);
}

// Shadows lean cool and sunlit ground warm, a little.
vec3 applyLight(vec3 albedo, float light) {
  vec3 tint = light < 1.0
    ? mix(vec3(0.86, 0.92, 1.08), vec3(1.0), light)
    : mix(vec3(1.0), vec3(1.04, 1.01, 0.95), min(light - 1.0, 1.0));
  return albedo * light * tint;
}

// Signed distance to the smooth coast, tiles: + on land, - over water, 0 on
// impassable tiles. Bilinear between tile centres.
float coastSdfAt(vec2 uv) {
  return (texture(uClimate, uv).r * 255.0 - 128.0) / COAST_SDF_UNITS;
}

// The same, at a tile's own centre: its kind (> 0 land, < 0 water).
float tileCoastSdf(ivec2 tile) {
  return (texelFetch(uClimate, tile, 0).r * 255.0 - 128.0) / COAST_SDF_UNITS;
}

// The tile whose land a pixel shows. Up to the smooth coast, a water tile
// shows the land beside it (its nearest land neighbour); otherwise the tile
// itself. `mapSize` in tiles.
ivec2 coastTile(vec2 p, ivec2 tile, vec2 mapSize) {
  if (tileCoastSdf(tile) >= 0.0) return tile;
  ivec2 best = tile;
  float bestD = 1e9;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 q = tile + ivec2(i, j);
      if (q.x < 0 || q.y < 0 || q.x >= int(mapSize.x) || q.y >= int(mapSize.y)) continue;
      if (tileCoastSdf(q) <= 0.0) continue;
      vec2 d = p - (vec2(q) + 0.5);
      float dd = dot(d, d);
      if (dd < bestD) {
        bestD = dd;
        best = q;
      }
    }
  }
  return best;
}
