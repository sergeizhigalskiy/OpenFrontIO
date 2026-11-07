#version 300 es
precision highp float;

// The ring: a bright core in a dark casing, and a faint halo inside it.

in vec2 vPx;

uniform float uRadiusPx;
uniform vec3 uColor;
uniform float uAlpha;     // strength × fade with zoom

out vec4 fragColor;

const float CORE_PX = 1.6;    // half-width of the bright core
const float CASING_PX = 1.2;  // dark casing either side

void main() {
  float d = abs(length(vPx) - uRadiusPx);
  float core = 1.0 - smoothstep(CORE_PX - 0.5, CORE_PX + 0.5, d);
  float casing = 1.0 - smoothstep(CORE_PX + CASING_PX - 0.5, CORE_PX + CASING_PX + 0.5, d);
  float inside = 1.0 - smoothstep(uRadiusPx - 1.0, uRadiusPx, length(vPx));
  vec3 color = mix(vec3(0.05, 0.02, 0.02), uColor, core);
  float alpha = max(casing * 0.95, inside * 0.12);
  if (casing < 0.01) color = uColor;
  alpha *= uAlpha;
  if (alpha < 0.004) discard;
  fragColor = vec4(color, alpha);
}
