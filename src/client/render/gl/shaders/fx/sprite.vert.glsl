#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;
layout(location = 1) in vec3 aInstPos;   // x, y, fxType
layout(location = 2) in vec2 aInstFlags; // frameIdx (uint8), alpha (uint8)

#include "camera"
uniform vec4 uFxUV[FX_TYPE_COUNT];    // vTop, vSpan, uFrameSpan, 0
uniform vec4 uFxWorld[FX_TYPE_COUNT]; // worldW, worldH, 0, 0

out vec2  vAtlasUV;
flat out float vAlpha;

void main() {
  int type = int(aInstPos.z + 0.5);
  float frameIdx = floor(aInstFlags.x + 0.5);
  float alpha = aInstFlags.y / 255.0;

  vec4 uv = uFxUV[type];
  vec4 world = uFxWorld[type];

  vec2 center = vec2(aInstPos.x + 0.5, aInstPos.y + 0.5);
  vec2 worldPos = center + (aPos - 0.5) * vec2(world.x, world.y);

  // Upright in the isometric view, so the top-down art stays square on
  // screen; flat on the ground otherwise.
  gl_Position = uprightToClip(center, worldPos - center);

  float u = (frameIdx + aPos.x) * uv.z;
  float v = uv.x + aPos.y * uv.y;
  vAtlasUV = vec2(u, v);
  vAlpha = alpha;
}
