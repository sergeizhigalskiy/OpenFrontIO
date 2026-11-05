#version 300 es
precision highp float;
precision highp usampler2D;

// The map surface: land coloured by elevation, water by depth, forests,
// rivers and fords, lit by a hillshade. See TerrainPass.ts.
//
// Tile kinds come from the raw terrain bytes, read per tile, so coastlines
// and walls stay tile-crisp (territory is drawn per tile on top). Everything
// inside a kind is smooth: depth, coast distance and elevation come from the
// LINEAR-filtered SurfaceField (gl/terrain/SurfaceData.ts).

uniform usampler2D uTerrainBytes; // R8UI: bit 7 land, bits 0-4 magnitude
uniform sampler2D uSurface;       // RGBA8: depth, coast, wall, elevation
uniform usampler2D uFeatures;     // R8UI: packTerrainFeatures
uniform sampler2D uNoise;         // RG8 tileable: smooth noise, crowns
uniform int uHasFeatures;

uniform vec3 uBackground; // impassable terrain (matches the clear colour)
uniform vec3 uOcean;      // open water; shallows and deeps derive from it
uniform vec3 uSand;
uniform vec3 uPlains;
uniform vec3 uHighland;
uniform vec3 uMountain;   // the highest peaks (snow); lower slopes are rock

uniform float uShadeStrength; // hillshade contrast, 0 = relief off
uniform float uReliefScale;   // world tiles per elevation level
uniform vec3 uLightDir;       // unit vector toward the light
uniform float uTime;          // seconds, wraps every TIME_PERIOD

in vec2 vTile;
in vec2 vDepth;
out vec4 fragColor;

const vec2 MAP_SIZE = vec2(float(MAP_W), float(MAP_H));
// Encodings, mirrored from gl/terrain/SurfaceData.ts.
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

const vec3 FOAM = vec3(0.90, 0.95, 0.96);
const vec3 HAZE = vec3(0.74, 0.80, 0.86);
// Hillshade bounds and shadow softening (gl/terrain/Relief.ts).
const float MIN_SHADE = 0.55;
const float MAX_SHADE = 1.4;
const float SHADOW_SOFTNESS = 0.72;

// Tiles per screen pixel, for anti-aliasing and fading detail when zoomed out.
float gPx;

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

// Speed for `cycles` whole repeats per TIME_PERIOD.
float cyclesPerPeriod(float cycles) { return cycles / TIME_PERIOD; }

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

// uOcean is the open sea a few tiles out: lighter and greener in the
// shallows, darker and bluer over the deeps.
vec3 waterColor(float depth) {
  vec3 shallow = mix(uOcean, vec3(0.62, 0.84, 0.84), 0.30);
  vec3 deep = uOcean * vec3(0.66, 0.75, 0.85);
  vec3 c = mix(shallow, uOcean, smoothstep(0.0, 4.5, depth));
  return mix(c, deep, smoothstep(3.0, 22.0, depth));
}

// Slow drifting brightness variation of the water surface, about -1..1.
float waterShimmer(vec2 p) {
  float t = uTime;
  vec2 a = p / 41.0 + vec2(cyclesPerPeriod(12.0), cyclesPerPeriod(8.0)) * t;
  vec2 b = p / 23.0 + vec2(-cyclesPerPeriod(14.0), cyclesPerPeriod(18.0)) * t;
  float la = log2(max(gPx * NOISE_SIZE / 41.0, 1e-3));
  float lb = log2(max(gPx * NOISE_SIZE / 23.0, 1e-3));
  float n = textureLod(uNoise, a, la).r + textureLod(uNoise, b, lb).r - 1.0;
  // Fade out when zoomed far out: the drift would only read as flicker.
  return n * (1.0 - smoothstep(1.5, 4.0, gPx));
}

vec3 shadeWater(vec2 p, vec2 uv, float depth) {
  vec3 c = waterColor(depth);
  float shimmer = waterShimmer(p);
  c *= 1.0 + 0.03 * shimmer;

  if (depth < 3.0) {
    // Land toward the light shades the water beside it.
    if (uShadeStrength > 0.0) {
      vec2 texel = 1.0 / MAP_SIZE;
      float dx = waterDepth(texture(uSurface, uv + vec2(texel.x, 0.0)).r) - depth;
      float dy = waterDepth(texture(uSurface, uv + vec2(0.0, texel.y)).r) - depth;
      vec2 away = vec2(dx, dy);
      float toLight = dot(-away, uLightDir.xy) / max(length(away) * length(uLightDir.xy), 1e-4);
      float near = 1.0 - smoothstep(0.0, 2.2, depth);
      c *= 1.0 - 0.22 * uShadeStrength * near * max(toLight, 0.0);
    }
    // Foam where the water meets the shore, lapping in and out.
    float lap = sin(TAU * cyclesPerPeriod(110.0) * uTime + shimmer * 2.5);
    float width = max(0.28 + 0.07 * lap, 1.1 * gPx);
    float foam = 1.0 - smoothstep(0.0, width, depth);
    c = mix(c, FOAM, 0.55 * foam);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Land
// ---------------------------------------------------------------------------

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Palette by elevation level (0-30): plains, highland, brown uplands, bare
// rock, and the mountain colour (snow by default) on the highest ground.
vec3 landColor(float level, float slope, float snowJitter) {
  vec3 rock = mix(uHighland, vec3(luma(uHighland)), 0.75) * vec3(0.76, 0.76, 0.78);
  vec3 upland = uHighland * vec3(0.90, 0.87, 0.82);
  vec3 lowland = uPlains * vec3(0.95, 0.99, 0.93);
  vec3 c = mix(lowland, mix(uPlains, uHighland, 0.3), smoothstep(1.0, 9.5, level));
  c = mix(c, uHighland, smoothstep(8.5, 11.5, level));
  c = mix(c, upland, smoothstep(14.0, 22.0, level));
  c = mix(c, rock, smoothstep(20.0, 25.5, level));
  // Steep ground shows bare rock.
  float steep = smoothstep(0.5, 1.6, slope) * smoothstep(12.0, 18.0, level);
  c = mix(c, rock, 0.7 * steep);
  // Snow on the highest ground; steep faces shed it.
  float line = 28.0 + snowJitter;
  float snow = smoothstep(line, line + 1.2, level);
  snow *= 1.0 - 0.7 * smoothstep(1.4, 2.8, slope);
  return mix(c, uMountain, snow);
}

uint featureAt(ivec2 t) {
  t = clamp(t, ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  return texelFetch(uFeatures, t, 0).r & 3u;
}

float forestAt(ivec2 t) {
  return featureAt(t) == 1u ? 1.0 : 0.0;
}

// Forest canopy over the ground colour: clustered crowns lit from the
// light, with ragged edges. `shade` takes the shadow the woods cast beside
// them.
vec3 forestCanopy(vec2 p, vec3 ground, inout float shade) {
  // Forest coverage, bilinear over the four nearest tile centres.
  vec2 g = p - 0.5;
  ivec2 b = ivec2(floor(g));
  vec2 f = g - vec2(b);
  float f00 = forestAt(b);
  float f10 = forestAt(b + ivec2(1, 0));
  float f01 = forestAt(b + ivec2(0, 1));
  float f11 = forestAt(b + ivec2(1, 1));
  float m = mix(mix(f00, f10, f.x), mix(f01, f11, f.x), f.y);
  if (m <= 0.0) return ground;
  vec2 dm = vec2(mix(f10 - f00, f11 - f01, f.y), mix(f01 - f00, f11 - f10, f.x));
  vec2 lightXY = normalize(uLightDir.xy + 1e-5);

  // Crowns at two sizes, so the canopy clusters instead of tiling. Full
  // detail from about 8 pixels a tile; below 3 the woods are a smooth tone.
  float detail = 1.0 - smoothstep(0.12, 0.33, gPx);
  float big = NOISE_SIZE / CROWN_CELL * 1.7;
  float small = NOISE_SIZE / CROWN_CELL * 0.95;
  vec2 q = p + vec2(3.7, 1.3);
  float c1 = noiseAt(p, big).g;
  float c2 = noiseAt(q, small).g;
  float crown = max(c1, 0.85 * c2);
  float lit = max(noiseAt(p + lightXY * 0.18, big).g,
                  0.85 * noiseAt(q + lightXY * 0.12, small).g) - crown;
  float grove = noiseAt(p, 21.0).r;

  float edge = m + (crown - 0.5) * 0.45 * detail;
  float aa = max(0.7 * gPx, 0.04);
  float cover = smoothstep(0.5 - aa, 0.5 + aa, edge);

  vec3 base = mix(uPlains, vec3(0.17, 0.29, 0.16), 0.6);
  base *= 0.9 + 0.2 * grove;
  vec3 canopy = base * mix(1.0, 0.74 + 0.36 * crown, detail);
  canopy *= 1.0 + 0.8 * clamp(lit, -0.3, 0.3) * detail;
  // The rim of the woods facing the light catches it; the far rim is dark.
  float rim = clamp(dot(-dm, lightXY), -1.0, 1.0);
  canopy *= 1.0 + 0.12 * rim * (1.0 - smoothstep(0.5, 1.0, m));

  // Shadow cast on open ground beside the woods, away from the light.
  float shadowed = (1.0 - cover) * smoothstep(0.1, 0.5, m) *
    clamp(dot(normalize(dm + 1e-5), lightXY), 0.0, 1.0);
  shade *= 1.0 - 0.25 * shadowed;
  return mix(ground, canopy, cover);
}

// Rivers and fords over the lit ground. Waterway coverage is a smooth
// weighted vote of the 3x3 tiles around the point, so channels run smooth,
// diagonal steps stay joined, and wide rivers have no seams inside.
vec3 waterways(vec2 p, ivec2 tile, vec3 ground, float shimmer) {
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

  // River water: the sea's shallows, a little darker along the banks.
  vec3 water = waterColor(3.0) * (1.0 + 0.03 * shimmer);
  water *= 1.0 - 0.14 * (1.0 - smoothstep(EDGE, 0.85, river));

  // Ford: a pale sandy shoal, plainly shallower than the river, with
  // ripples drifting where the water runs fast over it (up close).
  vec3 shoal = mix(waterColor(0.0), uSand, 0.4);
  const float RIPPLE_TILES = 7.0;
  vec2 drift = vec2(RIPPLE_TILES * cyclesPerPeriod(24.0) * uTime);
  float ripple = abs(fract(noiseAt(p + drift, RIPPLE_TILES).r * 5.0) - 0.5);
  float rippleDetail = 1.0 - smoothstep(0.15, 0.35, gPx);
  shoal = mix(shoal, FOAM, 0.5 * smoothstep(0.36, 0.47, ripple) * rippleDetail);
  water = mix(water, shoal, isFord);

  // A thin damp bank just outside the water.
  float bank = smoothstep(EDGE - 0.2, EDGE, river) * (1.0 - inWater);
  vec3 c = mix(ground, ground * vec3(0.82, 0.82, 0.78), 0.7 * bank);
  return mix(c, water, inWater);
}

vec3 shadeLand(vec2 p, vec2 uv, ivec2 tile, vec4 sf) {
  // Relief samples k tiles out: one tile up close, wider when zoomed out so
  // the hillshade shows landforms instead of per-tile speckle.
  float k = clamp(1.5 * gPx, 1.5, 6.0);
  vec2 texel = k / MAP_SIZE;
  vec4 sL = texture(uSurface, uv - vec2(texel.x, 0.0));
  vec4 sR = texture(uSurface, uv + vec2(texel.x, 0.0));
  vec4 sU = texture(uSurface, uv - vec2(0.0, texel.y));
  vec4 sD = texture(uSurface, uv + vec2(0.0, texel.y));
  float unit = 255.0 / ELEVATION_UNITS;
  float level = elevationLevel(sf.a);
  // Elevation levels per tile, and the hollow/ridge curvature.
  vec2 grad = vec2(sR.a - sL.a, sD.a - sU.a) * unit * 0.5 / k;
  float slope = length(grad);
  float curvature = (sL.a + sR.a + sU.a + sD.a - 4.0 * sf.a) * unit / (k * k);

  vec2 macro = noiseAt(p, 97.0);
  float jitter = (noiseAt(p, 29.0).r - 0.5) * 2.0;
  vec3 albedo = landColor(level, slope, jitter);
  // Broad, faint variation so wide plains aren't flat paint.
  albedo *= 1.0 + (macro.r - 0.5) * 0.07;
  albedo.g *= 1.0 + (macro.r - 0.5) * 0.03;

  // Sand along low coasts.
  float coast = coastDistance(sf.g);
  float beach = (1.0 - smoothstep(0.3, 0.9, coast)) *
    (1.0 - smoothstep(6.0, 13.0, level));
  albedo = mix(albedo, uSand, beach);

  uint packed = uHasFeatures != 0 ? texelFetch(uFeatures, tile, 0).r : 0u;
  float shade = 1.0;
  if ((packed & 0x08u) != 0u) albedo = forestCanopy(p, albedo, shade);

  if (uShadeStrength > 0.0) {
    vec3 n = normalize(vec3(-grad * uReliefScale, 1.0));
    float lambert = max(dot(n, uLightDir), 0.0);
    float relief = lambert / max(uLightDir.z, 1e-3) - 1.0;
    // Faces turned from the light darken less than lit faces brighten would
    // suggest, so deep relief doesn't swallow the palette (or the territory
    // colours painted over it).
    relief = relief < 0.0 ? relief * SHADOW_SOFTNESS : relief;
    // Coast bevel: land rising from the water faces the light or turns away.
    vec2 inland = vec2(sR.g - sL.g, sD.g - sU.g);
    float facing = dot(-inland, uLightDir.xy) /
      max(length(inland) * length(uLightDir.xy), 1e-4);
    float bevel = facing * (1.0 - smoothstep(0.2, 1.6, coast));
    // Hollows a touch darker, ridges a touch lighter.
    float hollow = clamp(curvature * 0.06, -0.12, 0.12);
    shade *= 1.0 + uShadeStrength * (relief + 0.14 * bevel - hollow);
  }
  // The ground beside impassable walls falls into their shadow.
  float wall = wallDistance(sf.b);
  shade *= mix(0.55, 1.0, smoothstep(0.0, 2.5, wall));
  shade = clamp(shade, MIN_SHADE, MAX_SHADE);

  // Shadows lean cool, light leans toward white.
  vec3 c = shade <= 1.0
    ? albedo * shade * mix(vec3(1.0), vec3(0.94, 0.97, 1.05), (1.0 - shade) * 2.0)
    : albedo + (1.0 - albedo) * (shade - 1.0) * 0.5;

  if ((packed & 0x04u) != 0u) c = waterways(p, tile, c, waterShimmer(p));
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

void main() {
  vec2 p = vTile;
  vec2 fw = fwidth(p);
  gPx = max(fw.x, fw.y);
  ivec2 tile = clamp(ivec2(floor(p)), ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  uint tb = texelFetch(uTerrainBytes, tile, 0).r;
  vec2 uv = p / MAP_SIZE;
  vec4 sf = texture(uSurface, uv);

  bool wall = (tb & 0x80u) != 0u && (tb & 0x1fu) == 31u;
  vec3 c;
  if ((tb & 0x80u) == 0u) {
    c = shadeWater(p, uv, waterDepth(sf.r));
  } else if (wall) {
    c = shadeWall(wallDistance(sf.b));
  } else {
    c = shadeLand(p, uv, tile, sf);
  }

  // Tilted cameras: distant ground fades into a light haze (not walls,
  // which stay the background colour).
  if (vDepth.y > 0.0 && !wall) {
    float haze = smoothstep(vDepth.y * 1.1, vDepth.y * 3.0, vDepth.x);
    c = mix(c, HAZE, 0.22 * haze);
  }
  fragColor = vec4(c, 1.0);
}
