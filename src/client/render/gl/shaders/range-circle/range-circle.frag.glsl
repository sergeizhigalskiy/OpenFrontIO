#version 300 es
precision highp float;

// A structure's range during build preview, on the map surface: a light
// fill inside, an edge line in a dark casing at a constant on-screen width.

in vec2 vWorldPos;

uniform vec2 uCenter;    // circle centre, tiles
uniform float uRadius;   // radius, tiles
uniform vec3 uColor;
uniform float uOpacity;  // 1, or faint for the part behind a ridge

out vec4 fragColor;

const float STROKE_PX = 1.5;  // half-width of the edge line
const float CASING_PX = 1.0;  // dark casing either side of it

void main() {
  float dist = length(vWorldPos - uCenter);
  // Pixels inside the edge (negative outside), from the screen-space rate.
  float rate = max(length(vec2(dFdx(dist), dFdy(dist))), 1e-5);
  float edgePx = (uRadius - dist) / rate;
  if (edgePx < -(STROKE_PX + CASING_PX + 1.0)) discard;

  float fill = clamp(edgePx + 0.5, 0.0, 1.0) * 0.2;
  float a = abs(edgePx);
  float core = 1.0 - smoothstep(STROKE_PX - 0.5, STROKE_PX + 0.5, a);
  float casing =
    1.0 - smoothstep(STROKE_PX + CASING_PX - 0.5, STROKE_PX + CASING_PX + 0.5, a);

  vec3 color = uColor;
  float alpha = fill;
  if (casing * 0.85 > fill) {
    color = mix(vec3(0.06), uColor, core);
    alpha = casing * 0.85;
  }
  alpha *= uOpacity;
  if (alpha < 0.001) discard;
  fragColor = vec4(color, alpha);
}
