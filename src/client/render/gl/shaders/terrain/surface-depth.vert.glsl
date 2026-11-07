#version 300 es
precision highp float;

// Depth prepass for the map surface (MapSurface.drawDepth): the 3D mesh,
// placed exactly as every pass that drapes on it places it, so their
// fragments meet this depth and the ones behind a ridge fail the test.
layout(location = 0) in vec2 aPos;

#include "camera"

void main() {
  gl_Position = groundToClip(aPos);
}
