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
  float h = groundHeight(aPos);
  gl_Position = worldToClip(vec3(aPos, h));
  vTile = aPos;
  vWorld = vec3(aPos, h);
  vDepth = vec2(gl_Position.w, uCamUp.w);
}
