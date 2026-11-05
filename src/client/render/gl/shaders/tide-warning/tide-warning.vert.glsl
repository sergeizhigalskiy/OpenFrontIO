#version 300 es
precision highp float;

// Map surface: aPos ranges [0, mapW] x [0, mapH] in tile coords (the map
// quad, or the 3D mesh through drawMapSurface).
layout(location = 0) in vec2 aPos;

#include "camera"

out vec2 vWorld;

void main() {
  vWorld = aPos;
  gl_Position = groundToClip(aPos);
}
