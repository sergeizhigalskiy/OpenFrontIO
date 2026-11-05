#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;
uniform vec2 uCenter;   // world-space ruin tile (tile coords)
uniform float uRadius;  // world-space icon radius in tiles

out vec2 vLocal; // [-1, +1] local coords within the quad

void main() {
  vLocal = aPos * 2.0 - 1.0;
  // A tile of margin for the outline.
  float r = uRadius + 1.0;
  vec2 worldPos = uCenter + 0.5 + vLocal * r;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
