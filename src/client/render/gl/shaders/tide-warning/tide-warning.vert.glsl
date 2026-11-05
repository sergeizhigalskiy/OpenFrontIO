#version 300 es
precision highp float;

// Map quad: aPos ranges [0, mapW] x [0, mapH] in tile coords.
layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;

out vec2 vWorld;

void main() {
  vWorld = aPos;
  vec3 clip = uCamera * vec3(aPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
