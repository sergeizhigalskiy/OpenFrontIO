#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;         // quad corner [0,1]
layout(location = 1) in vec3 aLightPosIdx;  // x, y, typeIdx
layout(location = 2) in vec3 aLightColor;   // r, g, b

#include "camera"
uniform float uRadiusMultiplier;
uniform float uRadius[MAX_LIGHT_TYPES];
uniform float uIntensity[MAX_LIGHT_TYPES];

out vec2 vLocalPos;
flat out vec3 vColor;
flat out float vIntensity;

void main() {
  int typeIdx = int(aLightPosIdx.z);
  float radius = uRadius[typeIdx] * uRadiusMultiplier;
  vec2 center = vec2(aLightPosIdx.x + 0.5, aLightPosIdx.y + 0.5);
  vec2 worldPos = center + (aPos - 0.5) * radius * 2.0;

  gl_Position = anchoredToClip(center, worldPos - center);

  vLocalPos = aPos - 0.5; // [-0.5, 0.5]
  vColor = aLightColor.rgb;
  vIntensity = uIntensity[typeIdx];
}
