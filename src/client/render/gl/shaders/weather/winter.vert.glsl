#version 300 es
precision highp float;

// Map surface: aPos ranges [0, MAP_W] x [0, MAP_H] in tiles (the map quad,
// or the 3D mesh through drawMapSurface).
layout(location = 0) in vec2 aPos;

#include "camera"

out vec2 vUV;

void main() {
  gl_Position = groundToClip(aPos);
  vUV = aPos / vec2(float(MAP_W), float(MAP_H));
}
