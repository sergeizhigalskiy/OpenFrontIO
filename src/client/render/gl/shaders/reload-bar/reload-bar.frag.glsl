#version 300 es
precision highp float;

in vec2 vLocal;
flat in vec2 vSize;
flat in float vFill;
flat in float vReady;

uniform float uBorder;       // outline width, in tiles
uniform vec3 uReadyColor;    // a loaded round
uniform vec3 uReloadColor;   // the loaded part of a reloading round
uniform vec4 uEmptyColor;    // the rest of a reloading round

out vec4 fragColor;

void main() {
  float b = uBorder;
  if (
    vLocal.x < b || vLocal.y < b ||
    vLocal.x > vSize.x - b || vLocal.y > vSize.y - b
  ) {
    fragColor = vec4(0.0, 0.0, 0.0, 0.9);
    return;
  }
  float inner = vSize.x - 2.0 * b;
  if (vLocal.x - b < vFill * inner) {
    fragColor = vec4(vReady > 0.5 ? uReadyColor : uReloadColor, 1.0);
  } else {
    fragColor = uEmptyColor;
  }
}
