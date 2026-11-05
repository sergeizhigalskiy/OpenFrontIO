#version 300 es
precision highp float;
precision highp usampler2D;

// Per-tile mask (R8UI): 1 = the coming tide wave floods this tile.
uniform usampler2D uMask;
uniform float uTime; // seconds

in vec2 vWorld;
out vec4 fragColor;

void main() {
  ivec2 tc = clamp(ivec2(floor(vWorld)), ivec2(0), ivec2(MAP_W - 1, MAP_H - 1));
  if (texelFetch(uMask, tc, 0).r == 0u) discard;
  // Pulsing water tint with drifting diagonal stripes, so it reads over any
  // territory color.
  float pulse = 0.5 + 0.5 * sin(uTime * 4.0);
  float stripe = step(0.5, fract((vWorld.x + vWorld.y) / 6.0 - uTime * 0.5));
  vec3 color = mix(vec3(0.1, 0.45, 0.95), vec3(0.55, 0.85, 1.0), stripe);
  fragColor = vec4(color, 0.35 + 0.3 * pulse);
}
