#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

#include "camera"
uniform vec2 uCenter;   // world-space site tile (tile coords)
uniform float uRadius;  // world-space icon radius in tiles

out vec2 vLocal; // [-1, +1] local coords within the quad

void main() {
  vLocal = aPos * 2.0 - 1.0;
  // An icon: upright in 3D, like the structure icons.
  gl_Position = billboardToClip(uCenter + 0.5, vLocal * uRadius);
}
