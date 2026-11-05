#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D uTileTex;
uniform sampler2D uPalette;
uniform sampler2D uBorderTex;     // RGBA8 — border flags from BorderComputePass
uniform sampler2D uDefenseCoverageTex; // R8 — 1.0 = defended by same-owner post
uniform sampler2D uAffiliation;   // 256×2 RGBA8 — affiliation colors (row 0 = border)
uniform vec2 uMapSize;
uniform int uAltView;
uniform float uHighlightBrighten;
uniform float uDefenseCheckerDarken;
uniform float uEmbargoTintRatio;
uniform float uFriendlyTintRatio;
uniform vec3 uEmbargoTint;
uniform vec3 uFriendlyTint;

// Line geometry, in screen pixels unless noted.
uniform float uLineMinPx;     // border line width when zoomed all the way out
uniform float uLineMaxPx;     // ... and its cap when zoomed in
uniform float uLineTileFrac;  // width gained per pixel of tile size
uniform float uSeamPx;        // dark seam on the outer edge of the line
uniform float uSeamDarken;    // seam color = line color * this
uniform float uBandPx;        // soft darker band inside the line (past it)
uniform float uBandAlpha;     // its peak opacity
uniform float uBandDarken;    // band color = border/territory mix * this

in vec2 vWorldPos;
out vec4 fragColor;

uint ownerAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= int(uMapSize.x) || c.y >= int(uMapSize.y))
    return 0u;
  return texelFetch(uTileTex, c, 0).r & uint(OWNER_MASK);
}

// Borders are anti-aliased lines along the tile edges an owned tile shares
// with another owner (or with unowned land and water), at a near-constant
// on-screen width: a thin dark seam right at the edge, so neighbouring
// empires separate even when their colours are close, then the border
// colour, then a soft darker band fading into the fill. Each side of a shared
// edge draws its own half, so two empires meet as line | seam | seam | line.
// Zoomed far out a tile is under a pixel and the line simply covers the edge
// tiles, as the old tile stamp did.
void main() {
  // Screen footprint of a tile, taken before any branch so the derivatives
  // are well defined: tiles per pixel along each world axis. It is the local
  // projection, so it holds for the tilted and 3D cameras too.
  vec2 p = vWorldPos;
  float tpx = max(length(vec2(dFdx(p.x), dFdy(p.x))), 1e-5);
  float tpy = max(length(vec2(dFdx(p.y), dFdy(p.y))), 1e-5);

  ivec2 tc = ivec2(floor(p));
  if (tc.x < 0 || tc.y < 0 || tc.x >= int(uMapSize.x) || tc.y >= int(uMapSize.y)) discard;

  uint owner = texelFetch(uTileTex, tc, 0).r & uint(OWNER_MASK);
  if (owner == 0u) discard;

  // Pixels per tile, on the shorter axis so a line never outgrows its tile.
  float tilePx = 1.0 / max(tpx, tpy);
  float lineW = min(uLineMinPx + tilePx * uLineTileFrac, uLineMaxPx);
  // The seam fades in once tiles are a few pixels wide; below that it would
  // turn whole edge tiles dark.
  float seamW = min(uSeamPx, lineW * 0.5) * smoothstep(1.5, 4.0, tilePx);
  // The band stays inside the edge tile so it never steps at a tile seam.
  float bandW = min(lineW + uBandPx, tilePx * 0.9);
  // Widest the line can get (a hovered player's is thicker), plus AA.
  float reach = max(lineW * 1.75, bandW) + 1.0;

  // Distance in pixels from this pixel to each edge of its tile.
  vec2 f = p - vec2(tc);
  float dl = f.x / tpx;
  float dr = (1.0 - f.x) / tpx;
  float dt = f.y / tpy;
  float db = (1.0 - f.y) / tpy;
  if (min(min(dl, dr), min(dt, db)) > reach) discard;

  bool nl = dl < reach;
  bool nr = dr < reach;
  bool nt = dt < reach;
  bool nb = db < reach;
  // Pixels to the nearest edge shared with another owner (d), and to the
  // nearest one shared with another empire rather than unowned land or water
  // (dEmpire): only those get the dark seam.
  float d = 1e6;
  float dEmpire = 1e6;
  uint o;
  if (nl && (o = ownerAt(tc + ivec2(-1, 0))) != owner) { d = min(d, dl); if (o != 0u) dEmpire = min(dEmpire, dl); }
  if (nr && (o = ownerAt(tc + ivec2(1, 0))) != owner) { d = min(d, dr); if (o != 0u) dEmpire = min(dEmpire, dr); }
  if (nt && (o = ownerAt(tc + ivec2(0, -1))) != owner) { d = min(d, dt); if (o != 0u) dEmpire = min(dEmpire, dt); }
  if (nb && (o = ownerAt(tc + ivec2(0, 1))) != owner) { d = min(d, db); if (o != 0u) dEmpire = min(dEmpire, db); }
  // Corners where only the diagonal neighbour differs, so the lines meeting
  // at an inside corner join without a notch.
  if (nl && nt && (o = ownerAt(tc + ivec2(-1, -1))) != owner) { float c = length(vec2(dl, dt)); d = min(d, c); if (o != 0u) dEmpire = min(dEmpire, c); }
  if (nr && nt && (o = ownerAt(tc + ivec2(1, -1))) != owner) { float c = length(vec2(dr, dt)); d = min(d, c); if (o != 0u) dEmpire = min(dEmpire, c); }
  if (nl && nb && (o = ownerAt(tc + ivec2(-1, 1))) != owner) { float c = length(vec2(dl, db)); d = min(d, c); if (o != 0u) dEmpire = min(dEmpire, c); }
  if (nr && nb && (o = ownerAt(tc + ivec2(1, 1))) != owner) { float c = length(vec2(dr, db)); d = min(d, c); if (o != 0u) dEmpire = min(dEmpire, c); }
  if (d >= reach) discard;

  // Pre-computed border flags from BorderComputePass
  vec4 borderData = texelFetch(uBorderTex, tc, 0);
  bool isHighlightBorder = borderData.r > 0.75;
  float relation = borderData.a;        // 0.0=neutral, ~0.5=friendly, ~1.0=embargo
  bool defense = texelFetch(uDefenseCoverageTex, tc, 0).r > 0.5; // same-owner defense post nearby

  float u = (float(owner) + 0.5) / float(PALETTE_SIZE);
  vec3 fill = texture(uPalette, vec2(u, 0.25)).rgb;
  vec3 bc;
  if (uAltView != 0) {
    // Alt-view: pure affiliation color from palette row 0
    bc = texelFetch(uAffiliation, ivec2(int(owner), 0), 0).rgb;
    fill = bc;
  } else {
    bc = texture(uPalette, vec2(u, 0.75)).rgb;
    if (isHighlightBorder) {
      bc = mix(bc, vec3(1.0), uHighlightBrighten);
      lineW *= 1.75;
    }
    // Relationship tint (applied BEFORE defense checkerboard, matching game)
    if (relation > 0.75) {
      bc = mix(bc, uEmbargoTint, uEmbargoTintRatio);
    } else if (relation > 0.25) {
      bc = mix(bc, uFriendlyTint, uFriendlyTintRatio);
    }
    // Defense bonus: the line is dashed tile by tile (applied AFTER tint)
    if (defense) {
      bool checker = ((tc.x + tc.y) & 1) == 1;
      if (checker) bc *= uDefenseCheckerDarken;
    }
  }

  // Coverage of each layer, anti-aliased over about a pixel. The band starts
  // at the line's inner edge and fades out across the rest of its width.
  float line = 1.0 - smoothstep(lineW - 0.5, lineW + 0.5, d);
  float seam = seamW > 0.0 ? 1.0 - smoothstep(seamW - 0.5, seamW + 0.5, dEmpire) : 0.0;
  float band = 1.0 - smoothstep(lineW, max(bandW, lineW + 1e-3), d);
  band *= uBandAlpha;

  vec3 bandColor = mix(fill, bc, 0.5) * uBandDarken;
  vec3 color = mix(bandColor, bc, line);
  color = mix(color, bc * uSeamDarken, seam);
  float alpha = max(line, band);
  if (alpha < 0.004) discard;
  fragColor = vec4(color, alpha);
}
