#version 300 es
precision highp float;

// Contact shadow (passes/ContactShadow.ts): a soft dark ellipse on the
// ground under each instance of a pass's sprites, drawn with that pass's own
// VAO. Location 1 is the pass's per-instance attribute; its first two
// components are the tile position, as in unit.vert and structure.vert.
layout(location = 0) in vec2 aPos;  // unit quad [0, 1]
layout(location = 1) in vec2 aInst; // tile x, y

#include "camera"

uniform float uRadius; // world tiles
uniform vec2 uShift;   // world tiles, away from the sun

out vec2 vLocal;

void main() {
  vLocal = aPos * 2.0 - 1.0;
  vec2 center = aInst + 0.5;
  // Flat on the ground at the sprite's anchor height.
  gl_Position = anchoredToClip(center, uShift + vLocal * uRadius);
}
