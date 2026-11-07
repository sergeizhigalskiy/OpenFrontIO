#version 300 es
precision highp float;

// Map surface: [0, mapW] x [0, mapH] in tiles (the map quad, or the 3D mesh
// through drawMapSurface).
layout(location = 0) in vec2 aPos;

#include "camera"

// Map position in tiles.
out vec2 vTile;
// World position (tiles, height in tiles): the eye direction for the water.
out vec3 vWorld;
// x: view depth of this point, y: the camera's focus distance (0 when the
// camera is orthographic). Interpolated perspective-correctly, so the
// fragment shader gets the exact depth for its distance haze.
out vec2 vDepth;

void main() {
  // groundToClip, as every pass draped on the surface places it, so the
  // depth test (MapSurface.ts) sees the same depth for all of them.
  float h = groundHeight(aPos);
  gl_Position = groundToClip(aPos);
  vTile = aPos;
  vWorld = vec3(aPos, h);
  vDepth = vec2(gl_Position.w, uCamUp.w);
}
