#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform float uRadius;

out vec4 fragColor;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  // Tile units; world y points down, so flip it to stand the ruins upright.
  float r = uRadius;
  vec2 p = vec2(vLocal.x, -vLocal.y) * (r + 1.0);
  // A stone slab with three columns on it, the middle one broken off.
  float d = sdBox(p - vec2(0.0, -0.75 * r), vec2(0.95 * r, 0.18 * r));
  float colW = 0.16 * r;
  float base = -0.57 * r;
  d = min(d, sdBox(p - vec2(-0.6 * r, base + 0.6 * r), vec2(colW, 0.6 * r)));
  d = min(d, sdBox(p - vec2(0.0, base + 0.3 * r), vec2(colW, 0.3 * r)));
  d = min(d, sdBox(p - vec2(0.6 * r, base + 0.75 * r), vec2(colW, 0.75 * r)));
  // Light stone, shaded toward the bottom, with a dark outline.
  float fill = 1.0 - smoothstep(-0.25, 0.25, d);
  float outline = 1.0 - smoothstep(0.35, 0.85, d);
  if (outline < 0.01) discard;
  float shade = 0.85 + 0.15 * clamp(p.y / r, -1.0, 1.0);
  vec3 stone = vec3(0.86, 0.81, 0.70) * shade;
  vec3 color = mix(vec3(0.12, 0.10, 0.08), stone, fill);
  fragColor = vec4(color, outline);
}
