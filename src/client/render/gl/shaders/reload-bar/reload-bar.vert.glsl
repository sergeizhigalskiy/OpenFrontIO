#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;    // unit quad [0,1]x[0,1]
layout(location = 1) in vec4 aInst0;  // tileX, tileY, slot, slotCount
layout(location = 2) in vec2 aInst1;  // fill (0-1), ready (0/1)

uniform mat3 uCamera;
// Half a structure icon, in tiles, sized like structure.vert.glsl.
uniform float uHalfIcon;
// Row top below the icon center, row width, pip height, gap between pips;
// all in half-icon units.
uniform vec4 uLayout;

out vec2 vLocal;       // position inside the pip, in tiles
flat out vec2 vSize;   // pip size, in tiles
flat out float vFill;
flat out float vReady;

void main() {
  float slot = aInst0.z;
  float count = max(aInst0.w, 1.0);
  float rowW = uLayout.y * uHalfIcon;
  float gap = uLayout.w * uHalfIcon;
  float w = (rowW - gap * (count - 1.0)) / count;
  float h = uLayout.z * uHalfIcon;

  // Ground space, like the structure icons: centered under the icon.
  vec2 center = aInst0.xy + 0.5;
  vec2 origin = vec2(
    center.x - rowW * 0.5 + slot * (w + gap),
    center.y + uLayout.x * uHalfIcon
  );

  vSize = vec2(w, h);
  vLocal = aPos * vSize;
  vFill = aInst1.x;
  vReady = aInst1.y;

  vec3 clip = uCamera * vec3(origin + vLocal, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
