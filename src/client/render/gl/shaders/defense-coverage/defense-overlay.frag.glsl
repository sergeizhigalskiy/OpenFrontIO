#version 300 es
precision highp float;

// Defense post coverage on the map (DefenseOverlayPass): a bright gold
// outline in a dark casing around every covered area, and a light hatch
// across it, so it reads on grass, rock and snow alike and can't be taken
// for a territory border (player colours, no casing) or for shading.
// Line widths and the hatch spacing are in screen pixels, so they hold at
// every zoom, tilt and orbit.

#include "camera"

uniform sampler2D uCoverage;  // R8, LINEAR: 1 = covered (DefenseCoveragePass)
uniform vec2 uMapSize;
uniform float uOpacity;       // 1, or faint for the part behind a ridge

in vec2 vWorldPos;
out vec4 fragColor;

const vec3 EDGE = vec3(1.0, 0.84, 0.3);
const vec3 CASING = vec3(0.05, 0.04, 0.02);
const float EDGE_PX = 1.5;       // half-width of the bright core
const float CASING_PX = 1.5;     // dark casing either side of it
const float HATCH_GAP_PX = 12.0; // stripe spacing
const float HATCH_PX = 0.9;      // half-width of a stripe's light core
const float HATCH_CASING_PX = 1.0;

// Coverage of one stripe set `period` apart along `u` (`du`: u per pixel):
// x the light core, y the dark casing around it.
vec2 stripes(float u, float du, float period) {
  float d = abs(fract(u / period) - 0.5) * period / du;
  float core = 1.0 - smoothstep(HATCH_PX - 0.5, HATCH_PX + 0.5, d);
  float casing =
    1.0 - smoothstep(HATCH_PX + HATCH_CASING_PX - 0.5, HATCH_PX + HATCH_CASING_PX + 0.5, d);
  return vec2(core, casing);
}

void main() {
  vec2 p = vWorldPos;
  // Covered share, bilinear between tile centres: 0.5 is the edge, rounded
  // across the tile steps. Pixels to it from its screen-space rate.
  float v = texture(uCoverage, p / uMapSize).r;
  float rate = length(vec2(dFdx(v), dFdy(v)));
  float edgePx = (v - 0.5) / max(rate, 1e-5);

  // Hatch: diagonal on screen at any orbit, fixed to the ground. `u` is the
  // point's screen right + up in world tiles (its height included, so the
  // stripes stay straight over relief); the spacing steps by powers of two
  // with the zoom, fading between steps, so it stays near HATCH_GAP_PX.
  vec3 w = vec3(p, groundHeight(p));
  float u = (dot(w, uCamRight.xyz) + dot(w, normalize(uCamUp.xyz))) * 0.70710678;
  float du = max(length(vec2(dFdx(u), dFdy(u))), 1e-6);
  float lod = log2(HATCH_GAP_PX * du);
  float base = exp2(floor(lod));
  vec2 fine = stripes(u, du, base);
  vec2 coarse = stripes(u, du, base * 2.0);
  vec2 hatch = mix(fine, coarse, smoothstep(0.0, 1.0, fract(lod)));

  float a = abs(edgePx);
  float core = 1.0 - smoothstep(EDGE_PX - 0.5, EDGE_PX + 0.5, a);
  float casing = 1.0 - smoothstep(EDGE_PX + CASING_PX - 0.5, EDGE_PX + CASING_PX + 0.5, a);
  // The hatch stays clear of the outline.
  float inside = smoothstep(EDGE_PX + CASING_PX + 1.0, EDGE_PX + CASING_PX + 4.0, edgePx);

  vec3 color = mix(CASING, EDGE, core);
  float alpha = casing * 0.95;
  float hatchAlpha = inside * max(hatch.x * 0.55, hatch.y * 0.35);
  if (hatchAlpha > alpha) {
    color = mix(CASING, vec3(1.0, 0.93, 0.7), hatch.x);
    alpha = hatchAlpha;
  }
  alpha *= uOpacity;
  if (alpha < 0.004) discard;
  fragColor = vec4(color, alpha);
}
