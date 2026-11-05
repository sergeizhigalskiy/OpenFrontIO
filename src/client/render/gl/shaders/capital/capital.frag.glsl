#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform float uRadius;
uniform vec3 uColor;   // owner's territory color

out vec4 fragColor;

// Signed distance to a five-pointed star of outer radius r (Inigo Quilez).
float sdStar5(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void main() {
  // Tile units; world y points down, so flip it to stand the star upright.
  vec2 p = vec2(vLocal.x, -vLocal.y) * (uRadius + 1.0);
  float d = sdStar5(p, uRadius, 0.45);
  // Gold fill rimmed with the owner's color, then a dark outline.
  float fill = 1.0 - smoothstep(-0.25, 0.25, d);
  float rim = 1.0 - smoothstep(-0.9, -0.5, d);
  float outline = 1.0 - smoothstep(0.35, 0.85, d);
  if (outline < 0.01) discard;
  vec3 gold = vec3(1.0, 0.84, 0.2);
  vec3 color = mix(uColor, gold, rim);
  color = mix(vec3(0.05), color, fill);
  fragColor = vec4(color, outline);
}
