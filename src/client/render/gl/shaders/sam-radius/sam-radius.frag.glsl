#version 300 es
precision highp float;

in float vAngle;
in float vSide;
flat in float vRadius;
flat in vec4 vColor;
flat in vec2 vArcBounds;
flat in float vSpin;

uniform float uTime;
uniform float uOutline;        // 1.0 = owner mode (outline edges), 0.0 = perspective
uniform float uHalfWidthPx;    // ring half-width on screen, px
uniform float uDashLen;        // dash length (world units)
uniform float uGapLen;         // gap length (world units)
uniform float uRotationSpeed;  // rotation (world units/sec)
uniform float uAlpha;          // base opacity
uniform float uOutlinePx;      // outline width on screen, px
uniform float uOpacity;        // 1, or faint for the part behind a ridge

out vec4 fragColor;

const float TWO_PI = 6.2831853;

void main() {
  // Pixels inside the ring's edge, across the strip.
  float edgePx = uHalfWidthPx - abs(vSide) * (uHalfWidthPx + 1.0);
  float ringAlpha = clamp(edgePx + 0.5, 0.0, 1.0);
  if (ringAlpha < 0.01) discard;

  // Dash pattern along the circumference (world units), its ends
  // anti-aliased over a pixel.
  float arcPos = vAngle * vRadius;
  float perPx = max(fwidth(arcPos), 1e-4);
  float period = uDashLen + uGapLen;
  float dashPhase = mod(arcPos + uTime * uRotationSpeed * vSpin, period);
  float dashAlpha = smoothstep(0.0, perPx, dashPhase)
                  * (1.0 - smoothstep(uDashLen - perPx, uDashLen, dashPhase));

  float alpha = ringAlpha * dashAlpha * uAlpha * vColor.a;
  if (alpha < 0.01) discard;

  // Outline: darken near any edge of each dash segment, in pixels.
  float edgeFade = 1.0;
  if (uOutline > 0.5) {
    float ow = uOutlinePx;
    edgeFade = smoothstep(ow - 0.5, ow + 0.5, edgePx);
    float endPx = min(dashPhase, uDashLen - dashPhase) / perPx;
    edgeFade = min(edgeFade, smoothstep(ow - 0.5, ow + 0.5, endPx));
    // Arc ends where the circle union clips the arc.
    bool fullCircle = vArcBounds.y - vArcBounds.x >= TWO_PI - 0.001;
    if (!fullCircle) {
      float arcEndPx = min(vAngle - vArcBounds.x, vArcBounds.y - vAngle) * vRadius / perPx;
      edgeFade = min(edgeFade, smoothstep(ow - 0.5, ow + 0.5, arcEndPx));
    }
  } else {
    // A thin dark rim, so the ring reads on any ground.
    edgeFade = mix(0.3, 1.0, smoothstep(0.5, 1.5, edgePx));
  }

  fragColor = vec4(vColor.rgb * edgeFade, alpha * uOpacity);
}
