#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform vec3 uRing;   // owner's territory color, or a neutral grey
uniform float uOwned; // 1 when someone holds the site
uniform int uKind;    // index in RESOURCE_SITE_KINDS

out vec4 fragColor;

// 1 inside the shape whose implicit function `f` is negative inside,
// antialiased over about a pixel.
float fill(float f) {
  float w = fwidth(f);
  return 1.0 - smoothstep(-w, w, f);
}

// One icon per kind on a disc, ringed with the holder's color. Drawn in quad
// units, so it keeps its shape at every zoom; the pass picks the quad's size.
//   0 gold mine: a gold nugget (a diamond with a highlight facet), dark disc
//   1 oil field: a black oil drop with a small highlight, dark disc
//   2 fishing grounds: a light fish silhouette, blue disc
void main() {
  float d = length(vLocal);
  float aa = fwidth(d) * 1.5;
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (disc < 0.01) discard;

  // Ring: the outer band, in the holder's color.
  float ring = smoothstep(0.66 - aa, 0.66, d);
  vec3 ringColor = mix(vec3(0.75), uRing, uOwned);

  // Upright (world y points down, so flip it).
  vec2 p = vec2(vLocal.x, -vLocal.y);
  vec3 color;
  if (uKind == 1) {
    // Oil drop: a round bottom narrowing straight up to a point.
    vec2 q = p - vec2(0.0, -0.13);
    float r = 0.29;
    float top = 0.6; // the tip's height above the round part's center
    float f = q.y <= 0.0
      ? length(q) - r
      : max(abs(q.x) - r * (1.0 - q.y / top), q.y - top);
    float drop = fill(f);
    float shine = fill(length((q - vec2(-0.11, 0.02)) / vec2(0.06, 0.09)) - 1.0);
    vec3 oil = mix(vec3(0.03, 0.03, 0.04), vec3(0.75), shine);
    color = mix(vec3(0.3, 0.28, 0.25), oil, drop);
  } else if (uKind == 2) {
    // Fish facing left: an oval body, a triangle tail and a dark eye.
    float body = fill(length(vec2((p.x + 0.07) / 0.31, p.y / 0.17)) - 1.0);
    float tx = p.x - 0.18;
    float tail = fill(max(abs(p.y) - tx * 0.8, max(-tx, tx - 0.26)));
    float fish = max(body, tail);
    float eye = fill(length(p - vec2(-0.24, 0.04)) - 0.035);
    vec3 fishColor = mix(vec3(0.88, 0.95, 1.0), vec3(0.1, 0.2, 0.35), eye);
    color = mix(vec3(0.13, 0.36, 0.62), fishColor, fish);
  } else {
    // Nugget: a diamond.
    float diamond = abs(p.x) * 1.15 + abs(p.y);
    float nugget = 1.0 - smoothstep(0.5 - aa, 0.5, diamond);
    vec3 gold = vec3(1.0, 0.8, 0.2);
    // Upper-left facet lighter, lower-right darker.
    float facet = clamp(0.5 + (p.y - p.x) * 0.9, 0.0, 1.0);
    vec3 nuggetColor = mix(gold * 0.7, vec3(1.0, 0.93, 0.6), facet);
    color = mix(vec3(0.12, 0.1, 0.08), nuggetColor, nugget);
  }

  color = mix(color, ringColor, ring);
  // A thin dark outline around the whole disc.
  float outline = smoothstep(1.0 - aa * 3.0, 1.0 - aa, d);
  color = mix(color, vec3(0.05), outline * 0.8);
  fragColor = vec4(color, disc);
}
