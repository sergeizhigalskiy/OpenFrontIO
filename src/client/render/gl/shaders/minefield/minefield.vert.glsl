#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

#include "camera"
uniform vec2 uCenter;   // world-space field center (tile coords)
uniform float uRadius;  // world-space radius in tiles

out vec2 vLocal; // [-1, +1] local coords within the quad
out vec2 vWorld; // world-space position, for the mine dot grid

void main() {
  vLocal = aPos * 2.0 - 1.0;

  // Cover the circle's bounding box, plus a tile for the edge ring.
  float r = uRadius + 1.0;
  vec2 worldPos = uCenter + 0.5 + vLocal * r;
  vWorld = worldPos;

  gl_Position = anchoredToClip(uCenter + 0.5, vLocal * r);
}
