#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aInstData; // x, y, alpha

#include "camera"
uniform float uTilesPerPx;
// Quad half-size in screen px; visible outer ring = 0.8× (frag OUTER_R),
// the rest is headroom for SDF AA.
uniform float uRingScreenPx;

out vec2  vLocalPos;
flat out float vAlpha;

void main() {
  vec2 center = vec2(aInstData.x + 0.5, aInstData.y + 0.5);
  vAlpha = aInstData.z;

  float worldRadius = uRingScreenPx * uTilesPerPx;
  vec2 worldPos = center + (aPos - 0.5) * worldRadius * 2.0;

  gl_Position = anchoredToClip(center, worldPos - center);

  vLocalPos = (aPos - 0.5) * 2.0;
}
