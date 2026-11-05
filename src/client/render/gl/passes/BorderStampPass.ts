/**
 * BorderStampPass — territory borders + defense checkerboard.
 *
 * Always draws at full brightness (after the optional night composite).
 * Borders are anti-aliased lines along the tile edges between owners, at a
 * near-constant screen width (border-stamp.frag.glsl), with a dark seam at
 * the edge and a soft darker band inside. Reads pre-computed border flags
 * (highlight, relation) from the BorderComputePass RGBA8 buffer and defense
 * coverage from DefenseCoveragePass.
 */

import type { RenderSettings } from "../RenderSettings";
import { getPaletteSize } from "../utils/ColorUtils";
import { createMapQuad, createProgram, shaderSrc } from "../utils/GlUtils";
import { TILE_DEFINES } from "../utils/TileCodec";

import borderStampFragSrc from "../shaders/day-night/border-stamp.frag.glsl?raw";
import borderStampVertSrc from "../shaders/day-night/border-stamp.vert.glsl?raw";
import { drawMapSurface } from "../terrain/MapSurface";

export class BorderStampPass {
  private gl: WebGL2RenderingContext;
  private settings: RenderSettings;
  private mapW: number;
  private mapH: number;

  private program: WebGLProgram;
  private uMapSize: WebGLUniformLocation;
  private uHighlightBrighten: WebGLUniformLocation;
  private uDefenseCheckerDarken: WebGLUniformLocation;
  private uEmbargoTintRatio: WebGLUniformLocation;
  private uFriendlyTintRatio: WebGLUniformLocation;
  private uEmbargoTint: WebGLUniformLocation;
  private uFriendlyTint: WebGLUniformLocation;
  private uAltView: WebGLUniformLocation;
  private uLineMinPx: WebGLUniformLocation;
  private uLineMaxPx: WebGLUniformLocation;
  private uLineTileFrac: WebGLUniformLocation;
  private uSeamPx: WebGLUniformLocation;
  private uSeamDarken: WebGLUniformLocation;
  private uBandPx: WebGLUniformLocation;
  private uBandAlpha: WebGLUniformLocation;
  private uBandDarken: WebGLUniformLocation;

  private vao: WebGLVertexArrayObject;
  private tileTex: WebGLTexture;
  private paletteTex: WebGLTexture;
  private borderTex: WebGLTexture;
  private defenseCoverageTex: WebGLTexture | null = null;
  private affiliationTex: WebGLTexture | null = null;
  private altView = false;

  constructor(
    gl: WebGL2RenderingContext,
    mapW: number,
    mapH: number,
    tileTex: WebGLTexture,
    paletteTex: WebGLTexture,
    borderTex: WebGLTexture,
    settings: RenderSettings,
  ) {
    this.gl = gl;
    this.settings = settings;
    this.mapW = mapW;
    this.mapH = mapH;
    this.tileTex = tileTex;
    this.paletteTex = paletteTex;
    this.borderTex = borderTex;

    this.program = createProgram(
      gl,
      borderStampVertSrc,
      shaderSrc(borderStampFragSrc, {
        PALETTE_SIZE: getPaletteSize(),
        ...TILE_DEFINES,
      }),
      "BorderStampPass",
    );
    this.uMapSize = gl.getUniformLocation(this.program, "uMapSize")!;
    this.uHighlightBrighten = gl.getUniformLocation(
      this.program,
      "uHighlightBrighten",
    )!;
    this.uDefenseCheckerDarken = gl.getUniformLocation(
      this.program,
      "uDefenseCheckerDarken",
    )!;
    this.uEmbargoTintRatio = gl.getUniformLocation(
      this.program,
      "uEmbargoTintRatio",
    )!;
    this.uFriendlyTintRatio = gl.getUniformLocation(
      this.program,
      "uFriendlyTintRatio",
    )!;
    this.uEmbargoTint = gl.getUniformLocation(this.program, "uEmbargoTint")!;
    this.uFriendlyTint = gl.getUniformLocation(this.program, "uFriendlyTint")!;
    this.uAltView = gl.getUniformLocation(this.program, "uAltView")!;
    this.uLineMinPx = gl.getUniformLocation(this.program, "uLineMinPx")!;
    this.uLineMaxPx = gl.getUniformLocation(this.program, "uLineMaxPx")!;
    this.uLineTileFrac = gl.getUniformLocation(this.program, "uLineTileFrac")!;
    this.uSeamPx = gl.getUniformLocation(this.program, "uSeamPx")!;
    this.uSeamDarken = gl.getUniformLocation(this.program, "uSeamDarken")!;
    this.uBandPx = gl.getUniformLocation(this.program, "uBandPx")!;
    this.uBandAlpha = gl.getUniformLocation(this.program, "uBandAlpha")!;
    this.uBandDarken = gl.getUniformLocation(this.program, "uBandDarken")!;

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTileTex"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPalette"), 1);
    gl.uniform1i(gl.getUniformLocation(this.program, "uBorderTex"), 2);
    gl.uniform1i(gl.getUniformLocation(this.program, "uAffiliation"), 3);
    gl.uniform1i(gl.getUniformLocation(this.program, "uDefenseCoverageTex"), 4);

    this.vao = createMapQuad(gl, mapW, mapH);
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }
  setAffiliationTex(tex: WebGLTexture): void {
    this.affiliationTex = tex;
  }
  setDefenseCoverageTex(tex: WebGLTexture): void {
    this.defenseCoverageTex = tex;
  }

  /** Draw borders + defense dashes. Blending must be enabled. */
  draw(cameraMatrix: Float32Array): void {
    const gl = this.gl;
    const mo = this.settings.mapOverlay;

    gl.useProgram(this.program);
    gl.uniform2f(this.uMapSize, this.mapW, this.mapH);
    gl.uniform1f(this.uHighlightBrighten, mo.highlightBrighten);
    gl.uniform1f(this.uDefenseCheckerDarken, mo.defenseCheckerDarken);
    gl.uniform1f(this.uEmbargoTintRatio, mo.embargoTintRatio);
    gl.uniform1f(this.uFriendlyTintRatio, mo.friendlyTintRatio);
    gl.uniform3f(
      this.uEmbargoTint,
      mo.embargoTintR,
      mo.embargoTintG,
      mo.embargoTintB,
    );
    gl.uniform3f(
      this.uFriendlyTint,
      mo.friendlyTintR,
      mo.friendlyTintG,
      mo.friendlyTintB,
    );
    gl.uniform1i(this.uAltView, this.altView ? 1 : 0);
    gl.uniform1f(this.uLineMinPx, mo.borderLineMinPx);
    gl.uniform1f(this.uLineMaxPx, mo.borderLineMaxPx);
    gl.uniform1f(this.uLineTileFrac, mo.borderLineTileFrac);
    gl.uniform1f(this.uSeamPx, mo.borderSeamPx);
    gl.uniform1f(this.uSeamDarken, mo.borderSeamDarken);
    gl.uniform1f(this.uBandPx, mo.borderBandPx);
    gl.uniform1f(this.uBandAlpha, mo.borderBandAlpha);
    gl.uniform1f(this.uBandDarken, mo.borderBandDarken);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tileTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.borderTex);
    if (this.affiliationTex) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.affiliationTex);
    }
    if (this.defenseCoverageTex) {
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.defenseCoverageTex);
    }

    drawMapSurface(gl, this.vao);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }
}
