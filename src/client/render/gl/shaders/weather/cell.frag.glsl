#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]
in vec2 vWorld;

uniform float uRadius;
uniform int uKind;     // 0 = mud, 1 = sea storm, 2 = fog (WeatherKind)
uniform float uActive; // 0 = forecast (dashed outline), 1 = in effect
uniform float uFade;   // 0..1, fades an active cell in and out
uniform float uTime;   // seconds, for the animation

out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

vec3 kindColor() {
  if (uKind == 0) return vec3(0.45, 0.31, 0.16); // mud brown
  if (uKind == 1) return vec3(0.20, 0.28, 0.42); // storm slate
  return vec3(0.88, 0.90, 0.93);                 // fog grey
}

void main() {
  vec2 rel = vLocal * (uRadius + 2.0); // tiles from the center
  float dist = length(rel);
  vec3 color = kindColor();

  if (uActive < 0.5) {
    // Forecast: a dashed outline that slowly crawls around the circle.
    float ring = 1.0 - smoothstep(0.6, 1.4, abs(dist - uRadius));
    float dashes = max(12.0, floor(uRadius * 0.4));
    float angle = atan(rel.y, rel.x) / 6.2831853;
    float dash = step(0.5, fract(angle * dashes + uTime * 0.25));
    float a = ring * dash * 0.9;
    if (a < 0.01) discard;
    fragColor = vec4(mix(color, vec3(1.0), 0.45), a);
    return;
  }

  // In effect: a filled overlay with a soft edge.
  float edge = 1.0 - smoothstep(uRadius * 0.8, uRadius, dist);
  if (edge <= 0.0) discard;
  float a;
  if (uKind == 0) {
    // Mud: blotchy brown puddles.
    float n = fbm(vWorld * 0.09);
    a = 0.2 + 0.28 * smoothstep(0.4, 0.75, n);
  } else if (uKind == 1) {
    // Storm: spiral arms turning around the eye, over churning noise.
    float theta = atan(rel.y, rel.x);
    float arms = 0.5 + 0.5 * sin(theta * 3.0 + dist * 0.15 - uTime * 1.2);
    float n = fbm(vWorld * 0.06 + vec2(uTime * 0.08, uTime * 0.05));
    a = 0.18 + 0.22 * arms * smoothstep(0.1, 0.5, dist / uRadius) + 0.14 * n;
  } else {
    // Fog: thick drifting haze.
    float n = fbm(vWorld * 0.05 + vec2(uTime * 0.04, uTime * 0.025));
    a = 0.38 + 0.3 * n;
  }
  a *= edge * uFade;
  if (a < 0.01) discard;
  fragColor = vec4(color, a);
}
