#version 300 es
precision highp float;

// Map surface: [0, mapW] x [0, mapH] in tiles (the map quad, or the 3D mesh
// through drawMapSurface).
layout(location = 0) in vec2 aPos;

#include "camera"

// Map position in tiles, [0, mapW] x [0, mapH].
out vec2 vTile;

void main() {
  // Forests and rivers lie on the ground: draped on the 3D terrain.
  gl_Position = groundToClip(aPos);
  vTile = aPos;
}
