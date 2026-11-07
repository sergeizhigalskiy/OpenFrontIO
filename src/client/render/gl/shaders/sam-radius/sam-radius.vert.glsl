#version 300 es
precision highp float;

// A ring as a strip that follows the ground: each sample on the arc sits on
// the relief (groundHeight), and the strip is widened in screen space, so
// it drapes over hills at a constant on-screen width at every zoom, tilt
// and orbit.

// Strip vertex: x = position along the arc (0..1), y = side (-1 / +1)
layout(location = 0) in vec2 aStrip;
// Per-instance: x, y, radius
layout(location = 1) in vec3 aInstance;
// Per-instance: r, g, b, alpha
layout(location = 2) in vec4 aColor;
// Per-instance: arcStart, arcEnd, spin
layout(location = 3) in vec3 aArcBounds;

#include "camera"

uniform vec2 uViewport;     // drawing buffer, px
uniform float uHalfWidthPx; // ring half-width on screen

out float vAngle;           // angle on the circle
out float vSide;            // -1..1 across the strip (its full width)
flat out float vRadius;     // world-space radius for this instance
flat out vec4 vColor;       // relationship color + instance alpha
flat out vec2 vArcBounds;   // arc start/end in [0, 2PI)
flat out float vSpin;       // 1.0 = spinning, 0.0 = static

// Lift toward the eye, tiles, so the strip stays in front of the ground
// between its samples for the depth test (MapSurface.drawOverSurface).
const float RING_LIFT = 1.5;

vec4 ringClip(vec2 center, float r, float a) {
  vec2 g = center + r * vec2(cos(a), sin(a));
  vec3 p = vec3(g, groundHeight(g));
  vec3 toEye = uCamUp.w > 0.0 ? normalize(uCamEye.xyz - p) : -uCamForward.xyz;
  return worldToClip(p + toEye * RING_LIFT);
}

void main() {
  vRadius = aInstance.z;
  vColor = aColor;
  vArcBounds = aArcBounds.xy;
  vSpin = aArcBounds.z;

  vec2 center = aInstance.xy + 0.5;
  float r = aInstance.z;
  float a = mix(aArcBounds.x, aArcBounds.y, aStrip.x);
  vAngle = a;

  vec4 clip = ringClip(center, r, a);
  // Screen tangent from samples half a tile either side.
  float da = 0.5 / max(r, 1.0);
  vec4 c0 = ringClip(center, r, a - da);
  vec4 c1 = ringClip(center, r, a + da);
  vec2 t = (c1.xy / c1.w - c0.xy / c0.w) * uViewport;
  vec2 n = length(t) > 1e-6 ? normalize(vec2(-t.y, t.x)) : vec2(0.0, 1.0);
  // One pixel beyond the ring for the anti-aliased edge.
  float half_ = uHalfWidthPx + 1.0;
  vSide = aStrip.y;
  clip.xy += n * aStrip.y * half_ * 2.0 / uViewport * clip.w;
  gl_Position = clip;
}
