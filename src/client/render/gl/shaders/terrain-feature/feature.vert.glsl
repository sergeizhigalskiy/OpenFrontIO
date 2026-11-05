#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;

uniform mat3 uCamera;

// Map position in tiles, [0, mapW] x [0, mapH].
out vec2 vTile;

void main() {
  vec3 clip = uCamera * vec3(aPos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  vTile = aPos;
}
