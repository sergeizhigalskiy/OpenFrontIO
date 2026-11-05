#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
#include "camera"
out vec2 vWorldPos;
void main() {
  gl_Position = groundToClip(aPos);
  vWorldPos = aPos;
}
