#version 300 es
precision highp float;

uniform sampler2D uTerrain;

// Hillshade (mirrors reliefNormal, hillshadeFactor and shadeChannel in
// gl/terrain/Relief.ts). uHeightField is RG8: R = smoothed height / 255
// (LINEAR), G = 1 on tiles that may be shaded (read with texelFetch).
uniform sampler2D uHeightField;
uniform float uShadeStrength; // 0 = hillshade off
uniform float uReliefScale;   // world tiles per height-map unit
uniform vec3 uLightDir;       // unit vector toward the light

in vec2 vUV;
out vec4 fragColor;

const float MIN_SHADE = 0.45;
const float MAX_SHADE = 1.45;

void main() {
  vec4 base = texture(uTerrain, vUV);
  if (uShadeStrength <= 0.0) {
    fragColor = base;
    return;
  }
  vec2 mapSize = vec2(float(MAP_W), float(MAP_H));
  ivec2 tile = clamp(ivec2(vUV * mapSize), ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  if (texelFetch(uHeightField, tile, 0).g < 0.5) {
    fragColor = base;
    return;
  }
  vec2 texel = 1.0 / mapSize;
  float l = texture(uHeightField, vUV - vec2(texel.x, 0.0)).r;
  float r = texture(uHeightField, vUV + vec2(texel.x, 0.0)).r;
  float u = texture(uHeightField, vUV - vec2(0.0, texel.y)).r;
  float d = texture(uHeightField, vUV + vec2(0.0, texel.y)).r;
  // R is height / 255: scale back to height units, then to world tiles.
  float zScale = 255.0 * uReliefScale * 0.5;
  vec3 n = normalize(vec3(-(r - l) * zScale, -(d - u) * zScale, 1.0));
  float lambert = max(dot(n, uLightDir), 0.0);
  float shade = 1.0 + uShadeStrength * (lambert / max(uLightDir.z, 1e-3) - 1.0);
  shade = clamp(shade, MIN_SHADE, MAX_SHADE);
  vec3 lit = shade <= 1.0
    ? base.rgb * shade
    : base.rgb + (1.0 - base.rgb) * (shade - 1.0) * 0.6;
  fragColor = vec4(lit, base.a);
}
