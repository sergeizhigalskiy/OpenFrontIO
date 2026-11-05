#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]

uniform float uRadius;
uniform int uMode;      // 0 = site icon, 1 = eruption glow
uniform float uTime;    // seconds, drives the rumble pulse
uniform float uRumble;  // 1.0 while the site rumbles
uniform float uAge;     // eruption glow: 0..1 through its life

out vec4 fragColor;

// Signed distance to an isosceles triangle with its apex at the origin,
// q = (half base, -height) so it opens downward (Inigo Quilez).
float sdTriangleIsosceles(vec2 p, vec2 q) {
  p.x = abs(p.x);
  vec2 a = p - q * clamp(dot(p, q) / dot(q, q), 0.0, 1.0);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  float s = -sign(q.y);
  vec2 d = min(
    vec2(dot(a, a), s * (p.x * q.y - p.y * q.x)),
    vec2(dot(b, b), s * (p.y - q.y))
  );
  return -sqrt(d.x) * sign(d.y);
}

void main() {
  float r = uRadius;
  vec2 p = vLocal * (r + 1.0);

  if (uMode == 1) {
    // Eruption: a lava ring sweeps out to the eruption radius over the
    // filled area, and the whole glow fades.
    float dist = length(p);
    float ringR = r * min(1.0, uAge * 3.0);
    float ring = 1.0 - smoothstep(0.0, 1.5, abs(dist - ringR));
    float fill = 1.0 - smoothstep(r - 1.0, r, dist);
    float fade = 1.0 - uAge;
    float alpha = (ring * 0.85 + fill * 0.4) * fade;
    if (alpha < 0.01) discard;
    vec3 color = mix(vec3(0.95, 0.2, 0.03), vec3(1.0, 0.75, 0.25), ring);
    fragColor = vec4(color, alpha);
    return;
  }

  // Tile units; world y points down, so flip it to stand the cone upright.
  p.y = -p.y;
  // A cone cut flat at the top, with a lava crater on the cut.
  float top = 0.3 * r;
  float body = max(
    sdTriangleIsosceles(p - vec2(0.0, 0.75 * r), vec2(0.95 * r, -1.4 * r)),
    p.y - top
  );
  vec2 craterP = (p - vec2(0.0, top)) / vec2(0.28 * r, 0.09 * r);
  float crater = length(craterP) - 1.0;

  float pulse = uRumble * (0.5 + 0.5 * sin(uTime * 8.0));
  float fill = 1.0 - smoothstep(-0.25, 0.25, body);
  float outline = 1.0 - smoothstep(0.35, 0.85, body);
  // While it rumbles, a red halo throbs around the cone.
  float halo = uRumble * (1.0 - smoothstep(0.0, 0.5 * r, body)) * (0.35 + 0.45 * pulse);
  float alpha = max(outline, halo);
  if (alpha < 0.01) discard;

  // Shade the right flank darker for some depth.
  vec3 rock = mix(vec3(0.42, 0.27, 0.18), vec3(0.28, 0.17, 0.11), step(0.0, p.x));
  vec3 lava = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.85, 0.3), pulse);
  float lavaMask = 1.0 - smoothstep(-0.15, 0.15, crater);
  vec3 color = mix(rock, lava, lavaMask);
  color = mix(vec3(0.05), color, fill);
  color = mix(vec3(0.9, 0.15, 0.05), color, outline);
  fragColor = vec4(color, alpha);
}
