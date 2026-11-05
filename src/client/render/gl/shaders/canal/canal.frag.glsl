#version 300 es
precision highp float;

in vec2 vLocal;   // x: 0..1 along the dig, y: -1..1 across it
in float vLength; // tiles

uniform vec3 uOwner;      // builder's territory color
uniform float uProgress;  // 0..1 of the construction time
uniform float uAlpha;     // 1 for a dig, less for the build preview

out vec4 fragColor;

// A canal being dug: the dug part is water, filling from one end as the
// construction runs; the rest is hatched earth. Rimmed with the builder's
// color so it reads as theirs.
void main() {
  float along = vLocal.x;
  float across = abs(vLocal.y);
  vec3 water = vec3(0.16, 0.42, 0.72);
  vec3 earth = vec3(0.45, 0.33, 0.2);
  // Diagonal hatching on the earth, a stripe every tile.
  float hatch = step(0.5, fract((along * vLength + vLocal.y) * 0.5));
  vec3 undug = mix(earth, earth * 0.75, hatch);
  vec3 color = along <= uProgress ? water : undug;
  // The rim: the outer fifth across, in the builder's color.
  float rim = smoothstep(0.7, 0.8, across);
  color = mix(color, uOwner, rim);
  fragColor = vec4(color, 0.85 * uAlpha);
}
