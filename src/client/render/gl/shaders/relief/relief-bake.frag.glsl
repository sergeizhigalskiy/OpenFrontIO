#version 300 es
precision highp float;

// Relief bake (terrain/ReliefBake.ts): per tile, how much sun reaches the
// ground and how open the sky above it is, cast from the relief heights.
// Rendered once into map-sized targets (and again around floods), so the
// terrain and territory shaders read soft shadows and ambient occlusion for
// the cost of a texture fetch.

uniform sampler2D uHeight;   // R16F relief heights: height units / 255
uniform vec2 uMapSize;
uniform float uHeightTiles;  // world tiles of height per unit of uHeight
uniform float uSunAlt;       // sun altitude above the horizon, radians

// Sun visibility toward the eight azimuths every 45 degrees (SceneLight.ts
// SHADOW_AZIMUTHS): 0-135 in A, 180-315 in B.
layout(location = 0) out vec4 outShadowA;
layout(location = 1) out vec4 outShadowB;
layout(location = 2) out vec4 outRelief; // R: sky openness

// Sun half-width, radians: the shadow edge softens over this.
const float PENUMBRA = 0.075;
const float MAX_REACH = 72.0;

float heightAt(vec2 p) {
  return textureLod(uHeight, p / uMapSize, 0.0).r * uHeightTiles;
}

// Compass azimuth (0 = north = -y, clockwise) to a ground direction.
vec2 compass(float az) {
  return vec2(sin(az), -cos(az));
}

// Fraction of the sun's disc above the horizon toward `az`.
float sunVisibility(vec2 p, float h0, float az) {
  vec2 d = compass(az);
  float steepest = -1e3;
  float t = 0.55;
  for (int i = 0; i < 26; i++) {
    float h = heightAt(p + d * t);
    steepest = max(steepest, (h - h0) / t);
    t += 0.42 + t * 0.11;
    if (t > MAX_REACH) break;
  }
  float horizon = atan(steepest);
  return smoothstep(-PENUMBRA, PENUMBRA, uSunAlt - horizon);
}

// Openness of the sky (1 = flat open ground, lower in valleys and hollows):
// the horizon angle in eight directions out to about twelve tiles.
float skyOpenness(vec2 p, float h0) {
  float occluded = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982 + 0.3927;
    vec2 d = vec2(cos(a), sin(a));
    float steepest = 0.0;
    float t = 0.9;
    for (int i = 0; i < 6; i++) {
      float h = heightAt(p + d * t);
      steepest = max(steepest, (h - h0) / t);
      t *= 1.6;
    }
    occluded += steepest / sqrt(1.0 + steepest * steepest);
  }
  return 1.0 - occluded / 8.0;
}

void main() {
  vec2 p = gl_FragCoord.xy;
  float h0 = heightAt(p);
  const float Q = 0.7853982; // 45 degrees
  outShadowA = vec4(
    sunVisibility(p, h0, 0.0),
    sunVisibility(p, h0, Q),
    sunVisibility(p, h0, 2.0 * Q),
    sunVisibility(p, h0, 3.0 * Q)
  );
  outShadowB = vec4(
    sunVisibility(p, h0, 4.0 * Q),
    sunVisibility(p, h0, 5.0 * Q),
    sunVisibility(p, h0, 6.0 * Q),
    sunVisibility(p, h0, 7.0 * Q)
  );
  outRelief = vec4(skyOpenness(p, h0), 1.0, 1.0, 1.0);
}
