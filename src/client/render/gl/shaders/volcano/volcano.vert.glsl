#version 300 es
precision highp float;

// Unit quad [0,1], as a DrapedQuad grid.
layout(location = 0) in vec2 aPos;

#include "camera"
uniform vec2 uCenter;   // world-space site tile (tile coords)
uniform float uRadius;  // world-space radius in tiles
// mediump to match the fragment shader's default int precision (a uniform
// in both stages must agree).
uniform mediump int uMode; // 0 = site icon, 1 = eruption glow

out vec2 vLocal; // [-1, +1] local coords within the quad

void main() {
  vLocal = aPos * 2.0 - 1.0;
  // A tile of margin for the outline.
  float r = uRadius + 1.0;
  vec2 center = uCenter + 0.5;
  // The icon stands upright in 3D; the glow lies on the ground, draped.
  gl_Position = uMode == 0
    ? billboardToClip(center, vLocal * r)
    : groundToClip(center + vLocal * r);
}
