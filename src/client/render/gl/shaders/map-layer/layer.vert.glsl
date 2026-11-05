#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

#include "camera"

out vec2 vUV;

void main() {
  gl_Position = groundToClip(aPos);

  // aPos ranges [0, mapW] × [0, mapH] — normalize to [0,1] UV.
  vUV = aPos / vec2(float(MAP_W), float(MAP_H));
}
