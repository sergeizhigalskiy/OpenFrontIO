#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform vec3 uRing;   // owner's territory color, or a neutral grey
uniform float uOwned; // 1 when someone holds the site

out vec4 fragColor;

// A gold mine: a gold nugget (a diamond with a highlight facet) on a dark
// disc, ringed with the holder's color. Drawn in quad units, so it keeps its
// shape at every zoom; the pass picks the quad's size.
void main() {
  float d = length(vLocal);
  float aa = fwidth(d) * 1.5;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (disc < 0.01) discard;

  // Ring: the outer band, in the holder's color.
  float ring = smoothstep(0.66 - aa, 0.66, d);
  vec3 ringColor = mix(vec3(0.75), uRing, uOwned);

  // Nugget: a diamond, upright (world y points down, so flip it).
  vec2 p = vec2(vLocal.x, -vLocal.y);
  float diamond = abs(p.x) * 1.15 + abs(p.y);
  float nugget = 1.0 - smoothstep(0.5 - aa, 0.5, diamond);
  vec3 gold = vec3(1.0, 0.8, 0.2);
  // Upper-left facet lighter, lower-right darker.
  float facet = clamp(0.5 + (p.y - p.x) * 0.9, 0.0, 1.0);
  vec3 nuggetColor = mix(gold * 0.7, vec3(1.0, 0.93, 0.6), facet);

  vec3 color = mix(vec3(0.12, 0.1, 0.08), nuggetColor, nugget);
  color = mix(color, ringColor, ring);
  // A thin dark outline around the whole disc.
  float outline = smoothstep(1.0 - aa * 3.0, 1.0 - aa, d);
  color = mix(color, vec3(0.05), outline * 0.8);
  fragColor = vec4(color, disc);
}
