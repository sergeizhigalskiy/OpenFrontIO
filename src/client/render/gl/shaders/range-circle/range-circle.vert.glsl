#version 300 es
precision highp float;

// Unit quad [0,1]
layout(location = 0) in vec2 aPos;

#include "camera"
uniform vec2 uCenter;   // world-space circle center (tile coords)
uniform float uRadius;  // world-space radius in tiles

out vec2 vLocal; // [-1, +1] local coords within the quad

void main() {
  // Map [0,1] → [-1,+1]
  vLocal = aPos * 2.0 - 1.0;

  // Expand quad to cover circle bbox in world space
  // Add 1-tile padding for the stroke
  float r = uRadius + 1.0;

  gl_Position = anchoredToClip(uCenter + 0.5, vLocal * r);
}
