#version 300 es
precision mediump float;

// Depth only: colour writes are masked off while this draws.
out vec4 fragColor;

void main() {
  fragColor = vec4(0.0);
}
