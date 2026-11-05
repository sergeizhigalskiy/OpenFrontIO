#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform float uRadius; // ring radius in tiles

out vec4 fragColor;

// Number of dashes around the ring.
const float DASHES = 8.0;

void main() {
  vec2 p = vLocal * (uRadius + 1.0); // tile units from the port's center
  float band = abs(length(p) - uRadius);
  // A red band about a tile wide, then a dark outline.
  float ring = 1.0 - smoothstep(0.35, 0.6, band);
  float outline = 1.0 - smoothstep(0.6, 0.95, band);
  // Dashed, like the cut rails: the blockade has the port surrounded.
  float dash = step(0.0, sin(atan(p.y, p.x) * DASHES));
  float alpha = outline * dash;
  if (alpha < 0.01) discard;
  vec3 red = vec3(0.86, 0.16, 0.16);
  fragColor = vec4(mix(vec3(0.05), red, ring), alpha);
}
