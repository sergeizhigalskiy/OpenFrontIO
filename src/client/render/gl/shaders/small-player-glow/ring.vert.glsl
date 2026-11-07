#version 300 es
precision highp float;

// A pulsing ring around a small player's territory: a quad centred on the
// player's name position on the ground, sized in screen pixels so it reads
// at any zoom, tilt and orbit.

layout(location = 0) in vec2 aCorner;   // unit quad, -1..1
layout(location = 1) in vec2 aAnchor;   // name position, tiles

#include "camera"

uniform vec2 uViewport;      // drawing buffer, px
uniform float uRadiusPx;     // ring radius (pulsing)
uniform float uMarginPx;     // quad beyond the ring for its casing and AA

out vec2 vPx;                // pixels from the centre

void main() {
  vec2 a = aAnchor + 0.5;
  vec4 c = worldToClip(vec3(a, groundHeight(a)));
  float half_ = uRadiusPx + uMarginPx;
  vPx = aCorner * half_;
  c.xy += aCorner * half_ * 2.0 / uViewport * c.w;
  gl_Position = c;
}
