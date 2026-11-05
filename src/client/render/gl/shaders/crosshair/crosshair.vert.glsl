#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos; // [0,1] quad

#include "camera"
uniform vec2 uCenter;    // world tile coords
uniform float uHalfSize; // half-size in pixels (screen space)
uniform vec2 uViewport;  // canvas width, height in pixels

out vec2 vLocal; // [-1, +1]

void main() {
  vLocal = aPos * 2.0 - 1.0;

  // Project center to clip space
  vec4 clip = groundToClip(uCenter + 0.5);

  // Offset in screen pixels → NDC (scaled by w so it survives the divide)
  vec2 pixelToNDC = 2.0 / uViewport;
  gl_Position = vec4(
    clip.xy + vLocal * uHalfSize * pixelToNDC * clip.w, clip.z, clip.w);
}
