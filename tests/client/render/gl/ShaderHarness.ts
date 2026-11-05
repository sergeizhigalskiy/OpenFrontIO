/**
 * Real WebGL2 shader checks for render passes, run in headless Chrome.
 *
 * capturePrograms() builds a pass against a recording stand-in for WebGL2
 * and collects the exact vertex/fragment sources createProgram hands the
 * driver (includes expanded, defines applied). compileInChrome() then
 * compiles and links every program in a real WebGL2 context (SwiftShader in
 * headless Chrome) and, for each of the three camera modes (flat, tilt,
 * terrain3d), binds the shared camera block filled the way the renderer
 * fills it and issues a draw, reporting any GL error.
 *
 * No browser binary means no check: findChrome() returns null and the test
 * skips.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  CAMERA_BLOCK_FLOATS,
  writeCameraBlock,
} from "../../../../src/client/render/gl/camera/CameraBlock";
import { computeCameraFrame } from "../../../../src/client/render/gl/camera/CameraMath";
import { HEIGHT_UNITS_PER_LEVEL } from "../../../../src/client/render/gl/terrain/Relief";

export interface CapturedProgram {
  pass: string;
  vs: string;
  fs: string;
}

export interface ProgramResult {
  pass: string;
  index: number;
  compiled: boolean;
  linked: boolean;
  log: string;
  usesCamera: boolean;
  /** UNIFORM_BLOCK_DATA_SIZE of CameraBlock, bytes (0 without it). */
  cameraBlockBytes: number;
  /** GL error after a draw in each camera mode (0 = none), or null if not drawn. */
  drawErrors: Record<string, number | null>;
}

const VERTEX_SHADER = 0x8b31;
const FRAGMENT_SHADER = 0x8b30;

/**
 * A WebGL2 stand-in that accepts every call and records shader sources and
 * links. Constants are distinct numbers; create* return fresh objects.
 */
export function recordingGL(onLink: (vs: string, fs: string) => void) {
  const constants = new Map<string, number>([
    ["VERTEX_SHADER", VERTEX_SHADER],
    ["FRAGMENT_SHADER", FRAGMENT_SHADER],
  ]);
  let nextConstant = 0x10000;
  const handlers: Record<string, (...args: never[]) => unknown> = {
    createShader: (type: number) => ({ type, src: "" }),
    shaderSource: (s: { src: string }, src: string) => {
      s.src = src;
    },
    createProgram: () => ({ shaders: [] as { type: number; src: string }[] }),
    attachShader: (
      p: { shaders: { type: number; src: string }[] },
      s: { type: number; src: string },
    ) => {
      p.shaders.push(s);
    },
    linkProgram: (p: { shaders: { type: number; src: string }[] }) => {
      const vs = p.shaders.find((s) => s.type === VERTEX_SHADER)?.src ?? "";
      const fsrc = p.shaders.find((s) => s.type === FRAGMENT_SHADER)?.src ?? "";
      onLink(vs, fsrc);
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    isContextLost: () => false,
    getError: () => 0,
    getExtension: () => null,
    getParameter: () => 4096,
    getAttribLocation: () => 0,
    getUniformBlockIndex: () => 0,
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in handlers) return handlers[prop];
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
          let v = constants.get(prop);
          if (v === undefined) {
            v = nextConstant++;
            constants.set(prop, v);
          }
          return v;
        }
        if (prop === "canvas") return { width: 1024, height: 768 };
        if (prop === "drawingBufferWidth") return 1024;
        if (prop === "drawingBufferHeight") return 768;
        return () => ({});
      },
    },
  ) as unknown as WebGL2RenderingContext;
}

/** Every program `build` links, tagged with `pass`. */
export function capturePrograms(
  pass: string,
  build: (gl: WebGL2RenderingContext) => unknown,
): CapturedProgram[] {
  const out: CapturedProgram[] = [];
  build(recordingGL((vs, fs) => out.push({ pass, vs, fs })));
  return out;
}

/** The camera block, as the renderer binds it, for each view mode. */
export function cameraBlocks(mapW: number, mapH: number) {
  const pose = {
    centerX: mapW / 2,
    centerY: mapH / 2,
    zoom: 4,
    viewW: 1024,
    viewH: 768,
    fovDeg: 40,
  };
  const modes = {
    flat: { tiltDeg: 0, terrain3d: false },
    tilt: { tiltDeg: 30, terrain3d: false },
    terrain3d: { tiltDeg: 30, terrain3d: true },
  };
  const blocks: Record<string, number[]> = {};
  for (const [name, m] of Object.entries(modes)) {
    const frame = computeCameraFrame({ ...pose, tiltDeg: m.tiltDeg });
    const data = writeCameraBlock(
      frame,
      {
        mapW,
        mapH,
        heightScale: m.terrain3d ? (255 / HEIGHT_UNITS_PER_LEVEL) * 0.3 : 0,
        billboard: m.terrain3d,
      },
      new Float32Array(CAMERA_BLOCK_FLOATS),
    );
    blocks[name] = Array.from(data);
  }
  return blocks;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome(): string | null {
  for (const c of CHROME_CANDIDATES) {
    if (c !== undefined && c !== "" && fs.existsSync(c)) return c;
  }
  return null;
}

// The page: compile, link, then draw once per camera mode with the block
// bound, samplers on distinct units with textures of their own type. A
// program with an unsigned-integer output (a tile-state scatter) draws into a
// small RGBA16UI target, as it does in the renderer, not the canvas.
const PAGE_SCRIPT = `
const out = [];
const canvas = document.createElement("canvas");
canvas.width = 64; canvas.height = 64;
const gl = canvas.getContext("webgl2");
if (!gl) { document.getElementById("out").textContent = "NO_WEBGL2"; }
else {
  const ubo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, 144, gl.DYNAMIC_DRAW);
  const tex = {};
  function texFor(type) {
    if (tex[type]) return tex[type];
    const t = gl.createTexture();
    if (type === gl.SAMPLER_2D_ARRAY) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      tex[type] = { t, target: gl.TEXTURE_2D_ARRAY };
      return tex[type];
    }
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (type === gl.UNSIGNED_INT_SAMPLER_2D) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 1, 1, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null);
    else if (type === gl.INT_SAMPLER_2D) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8I, 1, 1, 0, gl.RED_INTEGER, gl.BYTE, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    tex[type] = { t, target: gl.TEXTURE_2D };
    return tex[type];
  }
  const SAMPLERS = [gl.SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D, gl.INT_SAMPLER_2D, gl.SAMPLER_2D_ARRAY];
  // Made up front, then unbound, so making one never rebinds another unit.
  gl.activeTexture(gl.TEXTURE0);
  SAMPLERS.forEach(texFor);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  const vao = gl.createVertexArray();
  const uintTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, uintTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, 64, 64, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  const uintFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, uintFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, uintTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  PROGRAMS.forEach((p, index) => {
    const uintOut = /\\bout\\s+(highp\\s+|mediump\\s+|lowp\\s+)?(uvec[234]|uint)\\b/.test(p.fs);
    const r = { pass: p.pass, index, compiled: false, linked: false, log: "", usesCamera: false, cameraBlockBytes: 0, drawErrors: {} };
    const shaders = [[gl.VERTEX_SHADER, p.vs], [gl.FRAGMENT_SHADER, p.fs]].map(([type, src]) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) r.log += (type === gl.VERTEX_SHADER ? "VS: " : "FS: ") + gl.getShaderInfoLog(s) + "\\n";
      return s;
    });
    r.compiled = r.log === "";
    const prog = gl.createProgram();
    shaders.forEach((s) => gl.attachShader(prog, s));
    gl.linkProgram(prog);
    r.linked = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
    if (!r.linked) r.log += "LINK: " + gl.getProgramInfoLog(prog);
    if (r.linked) {
      const bi = gl.getUniformBlockIndex(prog, "CameraBlock");
      r.usesCamera = bi !== gl.INVALID_INDEX;
      if (r.usesCamera) r.cameraBlockBytes = gl.getActiveUniformBlockParameter(prog, bi, gl.UNIFORM_BLOCK_DATA_SIZE);
      gl.useProgram(prog);
      let unit = 0;
      let drawable = true;
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        if (!SAMPLERS.includes(info.type)) {
          if ([gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY, gl.INT_SAMPLER_2D_ARRAY, gl.SAMPLER_2D_SHADOW].includes(info.type)) drawable = false;
          continue;
        }
        const u = info.name === "uHeightMap" ? 15 : unit++;
        gl.uniform1i(gl.getUniformLocation(prog, info.name), u);
        const tt = texFor(info.type);
        gl.activeTexture(gl.TEXTURE0 + u);
        gl.bindTexture(tt.target, tt.t);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.getError();
      for (const [mode, block] of Object.entries(BLOCKS)) {
        if (!drawable) { r.drawErrors[mode] = null; continue; }
        gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, new Float32Array(block));
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
        gl.bindVertexArray(vao);
        if (uintOut) gl.bindFramebuffer(gl.FRAMEBUFFER, uintFbo);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        r.drawErrors[mode] = gl.getError();
        if (uintOut) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }
    out.push(r);
  });
  document.getElementById("out").textContent = btoa(JSON.stringify(out));
}
`;

/** Compiles, links and draws every program in headless Chrome. */
export function compileInChrome(
  chrome: string,
  programs: CapturedProgram[],
  blocks: Record<string, number[]>,
): ProgramResult[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-shaders-"));
  try {
    const html =
      `<!doctype html><html><body><pre id="out">PENDING</pre><script>` +
      `const PROGRAMS = ${JSON.stringify(programs)};\n` +
      `const BLOCKS = ${JSON.stringify(blocks)};\n` +
      PAGE_SCRIPT +
      `</script></body></html>`;
    const file = path.join(dir, "shaders.html");
    fs.writeFileSync(file, html);
    const stdout = execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu-sandbox",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${path.join(dir, "profile")}`,
        "--dump-dom",
        `file:///${file.replace(/\\/g, "/")}`,
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const m = /<pre id="out">([^<]*)<\/pre>/.exec(stdout);
    if (m === null) throw new Error("no result in the page");
    if (m[1] === "NO_WEBGL2") throw new Error("headless Chrome has no WebGL2");
    return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
  } finally {
    // Chrome can hold its profile a moment after exiting on Windows.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Left for the OS to clean up.
    }
  }
}
