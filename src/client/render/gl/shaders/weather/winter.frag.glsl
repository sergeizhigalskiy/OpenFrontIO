#version 300 es
precision highp float;
precision highp usampler2D;

// Raw terrain bytes (R8UI): bit 7 = land, bits 0-4 = magnitude.
uniform usampler2D uTerrainBytes;
// 0 = no winter, 1 = full winter (fades in and out).
uniform float uWinter;
// Tiles with y below this are the northern snow band.
uniform float uSnowRows;

in vec2 vUV;
out vec4 fragColor;

// Snow land, as engine-lib/game/Seasons.ts isSnowLand defines it: any
// passable land in the northern band. Magnitude 31 is impassable.
void main() {
  if (uWinter <= 0.001) discard;
  ivec2 tc = ivec2(int(vUV.x * float(MAP_W)), int(vUV.y * float(MAP_H)));
  tc = clamp(tc, ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  uint b = texelFetch(uTerrainBytes, tc, 0).r;
  bool land = (b & 0x80u) != 0u;
  uint magnitude = b & 0x1fu;
  if (!land || magnitude == 31u) discard;
  if (float(tc.y) >= uSnowRows) discard;

  // A little per-tile sparkle so the snow doesn't read as a flat wash.
  float n = fract(sin(dot(vec2(tc), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 color = mix(vec3(0.84, 0.91, 1.0), vec3(1.0), n);
  fragColor = vec4(color, uWinter * (0.34 + 0.14 * n));
}
