#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;
uniform vec2 uCenter;  // world-space cell center (tile coords)
uniform float uRadius; // world-space radius in tiles

out vec2 vLocal; // [-1, +1] within the quad
out vec2 vWorld; // world-space position, for the noise

void main() {
  vLocal = aPos * 2.0 - 1.0;
  // Cover the circle's bounding box, plus two tiles for the dashed ring.
  float r = uRadius + 2.0;
  vec2 worldPos = uCenter + 0.5 + vLocal * r;
  vWorld = worldPos;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
