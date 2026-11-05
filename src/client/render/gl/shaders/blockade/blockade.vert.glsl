#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

#include "camera"
uniform vec2 uCenter;   // world-space port tile (tile coords)
uniform float uRadius;  // world-space ring radius in tiles

out vec2 vLocal; // [-1, +1] local coords within the quad

void main() {
  vLocal = aPos * 2.0 - 1.0;
  // A tile of margin for the outline. A small ring on the ground around the
  // port, flat at the port's height like the range circles.
  float r = uRadius + 1.0;
  gl_Position = anchoredToClip(uCenter + 0.5, vLocal * r);
}
