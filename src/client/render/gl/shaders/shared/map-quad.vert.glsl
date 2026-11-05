#version 300 es
precision highp float;
// Camera-projected map quad -> tile-space UV. Shared by the bloom/glow
// composites so they sample an offscreen map-sized texture in world space.
layout(location = 0) in vec2 aPos;
#include "camera"
uniform vec2 uMapSize;
out vec2 vUV;
void main() {
  gl_Position = groundToClip(aPos);
  vUV = aPos / uMapSize;
}
