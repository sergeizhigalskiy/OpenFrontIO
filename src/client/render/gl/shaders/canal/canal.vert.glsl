#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;
uniform vec2 uStart;     // world-space center of the dig's first tile
uniform vec2 uEnd;       // world-space center of its last tile
uniform float uHalfWidth; // tiles either side of the center line

out vec2 vLocal; // x: 0..1 along the dig, y: -1..1 across it
out float vLength; // the dig's length in tiles

void main() {
  vec2 axis = uEnd - uStart;
  float len = length(axis);
  vec2 dir = len > 0.0 ? axis / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  // Half a tile past each end, so the end tiles are covered.
  float along = aPos.x * (len + 1.0) - 0.5;
  float across = (aPos.y * 2.0 - 1.0) * uHalfWidth;
  vec2 worldPos = uStart + dir * along + perp * across;
  vLocal = vec2(aPos.x, aPos.y * 2.0 - 1.0);
  vLength = len + 1.0;
  vec3 clip = uCamera * vec3(worldPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
