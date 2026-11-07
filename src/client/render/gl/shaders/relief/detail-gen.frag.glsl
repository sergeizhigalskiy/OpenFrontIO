#version 300 es
precision highp float;

// Ground detail textures (terrain/DetailTextures.ts), generated once at load
// into the layers of a tileable texture array. Original procedural work: no
// image assets. Per texel:
//   R  albedo multiplier / 2 (0.5 = unchanged)
//   G  normal x * 0.5 + 0.5
//   B  normal y * 0.5 + 0.5
//   A  height (0-1), for height-based blending between grounds; on the
//      water layer, the wave crests
//
// Every noise below repeats with the texture (integer lattice periods), so
// the layers tile without seams.

uniform int uLayer;
uniform float uSize; // texels per side

in vec2 vUV;
out vec4 fragColor;

const float TAU = 6.28318531;

float hash12(vec2 c) {
  vec3 p3 = fract(vec3(c.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 c) {
  vec3 p3 = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Value noise with `period` lattice cells per repeat; p in lattice units.
float vnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, period));
  float b = hash12(mod(i + vec2(1.0, 0.0), period));
  float c = hash12(mod(i + vec2(0.0, 1.0), period));
  float d = hash12(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// uv in [0,1): `cells` lattice cells across, `octaves` doubling octaves.
float fbm(vec2 uv, float cells, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    sum += amp * vnoise(uv * cells + float(i) * 13.7, cells);
    norm += amp;
    amp *= 0.5;
    cells *= 2.0;
  }
  return sum / norm;
}

// Distances to the nearest and second-nearest jittered cell points.
vec2 voronoi(vec2 uv, float cells) {
  vec2 p = uv * cells;
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(mod(i + g, cells));
      float d = length(g + o - f);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return vec2(d1, d2);
}

// --- Layers: height and albedo at uv --------------------------------------

// 0 grass: clumps and fine blades.
float grassHeight(vec2 uv) {
  float clumps = fbm(uv, 6.0, 4);
  float blades = vnoise(uv * vec2(96.0, 96.0), 96.0);
  float fine = vnoise(uv * 160.0 + 3.1, 160.0);
  return 0.5 * clumps + 0.3 * blades + 0.2 * fine;
}
float grassAlbedo(vec2 uv, float h) {
  float patches = fbm(uv + 0.37, 4.0, 3);
  return 0.72 + 0.56 * h + 0.2 * (patches - 0.5);
}

// 1 dry grass and steppe: tufts over bare soil.
float dryHeight(vec2 uv) {
  float tufts = smoothstep(0.5, 0.72, fbm(uv, 10.0, 4));
  float grain = vnoise(uv * 128.0, 128.0);
  return 0.65 * tufts + 0.35 * grain * (0.6 + 0.4 * tufts);
}
float dryAlbedo(vec2 uv, float h) {
  float tufts = smoothstep(0.5, 0.72, fbm(uv, 10.0, 4));
  return mix(1.12, 0.84, tufts) + 0.12 * (h - 0.5);
}

// 2 sand: wind ripples, gently warped, over fine grain.
float sandHeight(vec2 uv) {
  float warp = fbm(uv, 3.0, 3) - 0.5;
  float ripples = 0.5 + 0.5 * sin(TAU * (9.0 * uv.y + 4.0 * uv.x) + 5.0 * warp);
  ripples = pow(ripples, 1.6);
  float dunes = fbm(uv + 0.71, 2.0, 2);
  float grain = vnoise(uv * 200.0, 200.0);
  return 0.45 * ripples + 0.4 * dunes + 0.15 * grain;
}
float sandAlbedo(vec2 uv, float h) {
  float grain = vnoise(uv * 200.0 + 7.0, 200.0);
  return 0.94 + 0.14 * h + 0.06 * (grain - 0.5);
}

// 3 rock: tilted strata ledges, a few fractures, rough grain.
float strataAt(vec2 uv) {
  float warp = fbm(uv, 4.0, 3);
  return fract(9.0 * uv.y + 2.0 * uv.x + 1.6 * warp);
}
float rockHeight(vec2 uv) {
  float s = strataAt(uv);
  // Each layer a ledge: a sharp step up, then a slow slope back down.
  float ledge = smoothstep(0.0, 0.1, s) * (1.0 - 0.55 * s);
  vec2 v = voronoi(uv, 5.0);
  float crack = smoothstep(0.0, 0.05, v.y - v.x);
  float rough = fbm(uv + 0.2, 16.0, 4);
  return (0.5 * ledge + 0.5 * rough) * mix(0.8, 1.0, crack);
}
float rockAlbedo(vec2 uv, float h) {
  float s = strataAt(uv);
  float layer = fract(sin(floor(9.0 * uv.y + 2.0 * uv.x + 1.6 * fbm(uv, 4.0, 3)) * 12.9898) * 437.5);
  float bands = 0.9 + 0.2 * layer - 0.12 * (1.0 - smoothstep(0.0, 0.12, s));
  vec2 v = voronoi(uv, 5.0);
  float crack = smoothstep(0.0, 0.04, v.y - v.x);
  return bands * mix(0.8, 1.0, crack) * (0.88 + 0.24 * h);
}

// 4 snow: soft drifts with faint wind ripples.
float snowHeight(vec2 uv) {
  float drifts = fbm(uv, 3.0, 4);
  float ripple = 0.5 + 0.5 * sin(TAU * (5.0 * uv.x + 11.0 * uv.y) + 4.0 * drifts);
  return 0.8 * drifts + 0.2 * ripple;
}
float snowAlbedo(vec2 uv, float h) {
  return 0.97 + 0.06 * h;
}

// 5 tundra: moss and lichen mottling with scattered stones.
float tundraHeight(vec2 uv) {
  float moss = fbm(uv, 8.0, 4);
  vec2 v = voronoi(uv, 18.0);
  float stone = 1.0 - smoothstep(0.08, 0.22, v.x);
  return 0.6 * moss + 0.4 * stone;
}
float tundraAlbedo(vec2 uv, float h) {
  float moss = fbm(uv, 8.0, 4);
  vec2 v = voronoi(uv, 18.0);
  float stone = 1.0 - smoothstep(0.08, 0.22, v.x);
  return mix(0.86 + 0.3 * moss, 1.2, 0.7 * stone);
}

// 6 dirt and scrub: clods, pebbles, sparse low brush.
float dirtHeight(vec2 uv) {
  float clods = fbm(uv, 9.0, 4);
  vec2 v = voronoi(uv, 24.0);
  float pebble = 1.0 - smoothstep(0.05, 0.2, v.x);
  float brush = smoothstep(0.62, 0.8, fbm(uv + 0.5, 6.0, 3));
  return 0.55 * clods + 0.25 * pebble + 0.2 * brush;
}
float dirtAlbedo(vec2 uv, float h) {
  float brush = smoothstep(0.62, 0.8, fbm(uv + 0.5, 6.0, 3));
  vec2 v = voronoi(uv, 24.0);
  float pebble = 1.0 - smoothstep(0.05, 0.2, v.x);
  return (0.9 + 0.22 * h) * mix(1.0, 0.72, brush) + 0.12 * pebble;
}

// 7 water: crossing swells and chop; A marks the crests.
float waterHeight(vec2 uv) {
  float a = sin(TAU * (3.0 * uv.x + 2.0 * uv.y) + 2.0 * fbm(uv, 2.0, 2));
  float b = sin(TAU * (-2.0 * uv.x + 5.0 * uv.y) + 3.0 * fbm(uv + 0.3, 3.0, 2));
  float c = fbm(uv, 8.0, 4);
  return 0.5 + 0.18 * a + 0.12 * b + 0.35 * (c - 0.5);
}

float layerHeight(vec2 uv) {
  if (uLayer == 0) return grassHeight(uv);
  if (uLayer == 1) return dryHeight(uv);
  if (uLayer == 2) return sandHeight(uv);
  if (uLayer == 3) return rockHeight(uv);
  if (uLayer == 4) return snowHeight(uv);
  if (uLayer == 5) return tundraHeight(uv);
  if (uLayer == 6) return dirtHeight(uv);
  return waterHeight(uv);
}

float layerAlbedo(vec2 uv, float h) {
  if (uLayer == 0) return grassAlbedo(uv, h);
  if (uLayer == 1) return dryAlbedo(uv, h);
  if (uLayer == 2) return sandAlbedo(uv, h);
  if (uLayer == 3) return rockAlbedo(uv, h);
  if (uLayer == 4) return snowAlbedo(uv, h);
  if (uLayer == 5) return tundraAlbedo(uv, h);
  if (uLayer == 6) return dirtAlbedo(uv, h);
  return 1.0;
}

// Bump strength per layer: how far the height pushes the normal.
float layerBump() {
  if (uLayer == 2) return 2.2;  // sand ripples
  if (uLayer == 3) return 5.0;  // rock
  if (uLayer == 4) return 1.6;  // snow
  if (uLayer == 7) return 3.0;  // water
  return 3.2;
}

void main() {
  vec2 uv = vUV;
  float texel = 1.0 / uSize;
  float h = layerHeight(uv);
  float hx = layerHeight(uv + vec2(texel, 0.0)) - layerHeight(uv - vec2(texel, 0.0));
  float hy = layerHeight(uv + vec2(0.0, texel)) - layerHeight(uv - vec2(0.0, texel));
  // hx, hy span two texels; the bump turns texel-space slope into a normal.
  vec3 n = normalize(vec3(-hx * layerBump() * 2.0, -hy * layerBump() * 2.0, 1.0));
  float albedo = layerAlbedo(uv, h);
  float a = uLayer == 7 ? smoothstep(0.62, 0.8, h) : h;
  fragColor = vec4(clamp(albedo * 0.5, 0.0, 1.0), n.xy * 0.5 + 0.5, a);
}
