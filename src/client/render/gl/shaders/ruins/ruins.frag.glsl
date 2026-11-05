#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

out vec4 fragColor;

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// A badge in the resource sites' style (resource-site.frag.glsl): a dark
// disc with a light emblem, an unheld grey ring and a thin dark outline.
// The emblem is a stone slab with three columns on it, the middle one broken
// off. Drawn in quad units, so it keeps its shape at every zoom.
void main() {
  float d = length(vLocal);
  float aa = fwidth(d) * 1.5;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (disc < 0.01) discard;

  float ring = smoothstep(0.66 - aa, 0.66, d);

  // Upright (world y points down, so flip it).
  vec2 p = vec2(vLocal.x, -vLocal.y);
  // Slab, then the columns standing on it (left, broken middle, right).
  float g = sdBox(p - vec2(0.0, -0.32), vec2(0.4, 0.07));
  float colW = 0.075;
  float base = -0.25;
  g = min(g, sdBox(p - vec2(-0.24, base + 0.25), vec2(colW, 0.25)));
  g = min(g, sdBox(p - vec2(0.0, base + 0.12), vec2(colW, 0.12)));
  g = min(g, sdBox(p - vec2(0.24, base + 0.29), vec2(colW, 0.29)));
  float w = fwidth(g);
  float emblem = 1.0 - smoothstep(-w, w, g);
  // Light stone, shaded toward the bottom.
  float shade = 0.88 + 0.12 * clamp(p.y / 0.5, -1.0, 1.0);
  vec3 stone = vec3(0.88, 0.83, 0.72) * shade;
  vec3 color = mix(vec3(0.16, 0.14, 0.12), stone, emblem);

  color = mix(color, vec3(0.75), ring);
  // A thin dark outline around the whole disc.
  float outline = smoothstep(1.0 - aa * 3.0, 1.0 - aa, d);
  color = mix(color, vec3(0.05), outline * 0.8);
  fragColor = vec4(color, disc);
}
