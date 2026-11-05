#version 300 es
precision highp float;
precision highp usampler2D;

// Terrain features, drawn between the terrain and territory passes:
// forests as a dark green wash with a stipple of tree crowns, rivers as blue
// water, fords as lighter water crossed by sandy marks.

// One TerrainFeature per tile (R8UI): 0 none, 1 forest, 2 river, 3 ford.
uniform usampler2D uFeatures;

// Raw terrain bytes (R8UI): bit 7 = isLand. A water nuke can flood a
// feature tile; it then draws as plain water.
uniform usampler2D uTerrainBytes;

in vec2 vTile;
out vec4 fragColor;

const vec4 FOREST_WASH = vec4(0.12, 0.36, 0.14, 0.32);
const vec4 FOREST_CROWN = vec4(0.08, 0.27, 0.11, 0.62);
const vec4 RIVER = vec4(0.22, 0.46, 0.80, 0.92);
const vec4 RIVER_BANK = vec4(0.12, 0.27, 0.55, 0.95);
const vec4 FORD_WATER = vec4(0.47, 0.67, 0.86, 0.92);
const vec4 FORD_MARK = vec4(0.88, 0.84, 0.66, 0.95);

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

uint featureAt(ivec2 t) {
  t = clamp(t, ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  return texelFetch(uFeatures, t, 0).r;
}

bool isWaterway(uint f) {
  return f == 2u || f == 3u;
}

void main() {
  ivec2 tc = clamp(ivec2(floor(vTile)), ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  uint f = texelFetch(uFeatures, tc, 0).r;
  if (f == 0u) discard;
  uint terrainByte = texelFetch(uTerrainBytes, tc, 0).r;
  if ((terrainByte & 0x80u) == 0u) discard;

  vec2 local = fract(vTile);

  if (f == 1u) {
    // A crown on about half the tiles, jittered so the woods don't grid.
    vec2 cell = vec2(tc);
    vec4 color = FOREST_WASH;
    if (hash(cell) < 0.55) {
      vec2 center = 0.3 + 0.4 * vec2(hash(cell + 13.1), hash(cell + 71.7));
      if (length(local - center) < 0.32) color = FOREST_CROWN;
    }
    fragColor = color;
    return;
  }

  if (f == 3u) {
    // Stepping-stone stripes running across the river.
    float stripe = fract((vTile.x + vTile.y) * 0.5);
    fragColor = stripe < 0.3 ? FORD_MARK : FORD_WATER;
    return;
  }

  // River: darker along any edge that meets dry land, so 1-tile streams
  // still read as a line.
  float bank = 0.18;
  bool edge =
    (local.x < bank && !isWaterway(featureAt(tc + ivec2(-1, 0)))) ||
    (local.x > 1.0 - bank && !isWaterway(featureAt(tc + ivec2(1, 0)))) ||
    (local.y < bank && !isWaterway(featureAt(tc + ivec2(0, -1)))) ||
    (local.y > 1.0 - bank && !isWaterway(featureAt(tc + ivec2(0, 1))));
  fragColor = edge ? RIVER_BANK : RIVER;
}
