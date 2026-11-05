#version 300 es
precision highp float;

in vec2 vLocal; // [-1, +1]
in vec2 vWorld;

uniform float uRadius;
uniform vec3 uColor;
uniform float uDensity; // 0.1 .. 1.0
uniform float uDotSpacing; // tiles between drawn mines

out vec4 fragColor;

void main() {
  float dist = length(vLocal) * (uRadius + 1.0);

  // Shaded disc, a firmer ring at the edge, and a sparse grid of dots: the
  // mines. All three fade with the field's density.
  float fill = 1.0 - smoothstep(uRadius - 0.5, uRadius + 0.5, dist);
  float ring = smoothstep(uRadius - 1.5, uRadius - 0.5, dist) * fill;
  vec2 cell = fract(vWorld / uDotSpacing) - 0.5;
  float mine = (1.0 - smoothstep(0.12, 0.22, length(cell))) * fill;

  float alpha = fill * (0.05 + 0.2 * uDensity)
              + ring * (0.2 + 0.4 * uDensity)
              + mine * 0.55 * uDensity;
  if (alpha < 0.001) discard;

  fragColor = vec4(uColor, min(alpha, 1.0));
}
