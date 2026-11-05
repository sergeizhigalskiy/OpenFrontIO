#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;        // unit quad [0,1]x[0,1]
layout(location = 1) in vec3 aInstData;   // x, y, progress

#include "camera"
uniform vec2 uBarSize;     // (width, height) in world tiles
uniform vec2 uBarOffset;   // offset from unit center in tiles
uniform float uSolid;      // 1.0 = veterancy pip mode (aInstData.z is a stack slot)
uniform float uPipStride;  // vertical spacing between stacked pips, in tiles

out vec2 vLocalPos;        // [0, barWidth] x [0, barHeight]
flat out float vProgress;

void main() {
  float worldX = aInstData.x;
  float worldY = aInstData.y;
  vProgress = aInstData.z;

  vec2 center = vec2(worldX + 0.5, worldY + 0.5);
  vec2 offset = uBarOffset;
  // In pip mode each instance is one stacked rank bar; raise it by its slot.
  offset.y -= uSolid * aInstData.z * uPipStride;
  vec2 barOrigin = center + offset;
  vec2 worldPos = barOrigin + aPos * uBarSize;

  gl_Position = billboardToClip(center, worldPos - center);

  vLocalPos = aPos * uBarSize;
}
