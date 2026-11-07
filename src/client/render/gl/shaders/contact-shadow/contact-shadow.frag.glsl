#version 300 es
precision highp float;

in vec2 vLocal;
uniform float uStrength;
out vec4 fragColor;

void main() {
  float d = length(vLocal);
  float a = uStrength * (1.0 - smoothstep(0.25, 1.0, d));
  if (a < 0.004) discard;
  fragColor = vec4(0.03, 0.04, 0.07, a);
}
