// Shared camera — expanded in place of `#include "camera"` by createProgram
// (put the include after the precision line). Layout and docs: gl/camera/
// CameraBlock.ts. The renderer fills and binds the block once per frame, so
// passes never upload camera uniforms themselves.
//
// Placing geometry on the map:
//   groundToClip(p)              a point on the ground (draped on 3D terrain)
//   anchoredToClip(a, offset)    a flat sprite: offset lies on the ground at
//                                the anchor's height
//   billboardToClip(a, offset)   a label or icon: stands upright facing the
//                                camera in 3D mode (offset +y = down the
//                                screen), otherwise the same as anchored
//   camClipScale()               clip units per world tile at the focus point
//                                (what the old 2D matrix's x scale gave)
layout(std140) uniform CameraBlock {
  mat4 uViewProj;    // world (x, y, height) -> clip
  vec4 uCamRight;    // xyz: screen-right in world space; w: clip scale
  vec4 uCamUp;       // xyz: screen-up in world space; w: focus distance (0 = ortho)
  vec4 uCamForward;  // xyz: view direction
  vec4 uCamEye;      // xyz: eye position
  vec4 uCamSurface;  // x: 1/mapW, y: 1/mapH, z: height scale (0 = flat), w: billboards on
};
uniform sampler2D uHeightMap; // HeightField: R = smoothed height (0..1)

float groundHeight(vec2 world) {
  if (uCamSurface.z <= 0.0) return 0.0;
  return textureLod(uHeightMap, world * uCamSurface.xy, 0.0).r * uCamSurface.z;
}

vec4 worldToClip(vec3 p) {
  return uViewProj * vec4(p, 1.0);
}

vec4 groundToClip(vec2 world) {
  return worldToClip(vec3(world, groundHeight(world)));
}

vec4 anchoredToClip(vec2 anchor, vec2 offset) {
  return worldToClip(vec3(anchor + offset, groundHeight(anchor)));
}

vec4 billboardToClip(vec2 anchor, vec2 offset) {
  if (uCamSurface.w < 0.5) return anchoredToClip(anchor, offset);
  vec3 base = vec3(anchor, groundHeight(anchor));
  return worldToClip(base + uCamRight.xyz * offset.x - uCamUp.xyz * offset.y);
}

float camClipScale() {
  return uCamRight.w;
}
