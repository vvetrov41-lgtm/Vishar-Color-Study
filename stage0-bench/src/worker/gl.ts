// Minimal WebGL2 helpers for the bench: one full-screen pass that converts
// sRGB to CIE L* and posterizes it into Values levels.

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Same formulas as the Node prototype (experiments/src/csalgo.mjs): sRGB → linear → Y → L*.
const FRAG_VALUES = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform int uLevels;
out vec4 outColor;
float lin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float y = 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  float f = y > 0.008856 ? pow(y, 1.0 / 3.0) : 7.787 * y + 16.0 / 116.0;
  float L = 116.0 * f - 16.0;                // 0..100
  float n = float(uLevels);
  float q = floor(clamp(L / 100.0, 0.0, 0.9999) * n) / (n - 1.0);
  outColor = vec4(vec3(q), 1.0);
}`;

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texture(uSrc, vUv); }`;

export interface GlEnv {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  values: WebGLProgram;
  copy: WebGLProgram;
  lost: boolean;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl: WebGL2RenderingContext, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

let env: GlEnv | null = null;

export function getGl(): GlEnv {
  if (env && !env.lost && !env.gl.isContextLost()) return env;
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error('webgl2 context unavailable in worker');
  const e: GlEnv = { canvas, gl, values: program(gl, FRAG_VALUES), copy: program(gl, FRAG_COPY), lost: false };
  canvas.addEventListener('webglcontextlost', () => { e.lost = true; });
  env = e;
  return e;
}

export function glParams(gl: WebGL2RenderingContext) {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return {
    version: gl.getParameter(gl.VERSION),
    glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    MAX_TEXTURE_SIZE: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    MAX_RENDERBUFFER_SIZE: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    MAX_VIEWPORT_DIMS: [vp[0], vp[1]],
    MAX_TEXTURE_IMAGE_UNITS: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    MAX_DRAW_BUFFERS: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    extensions: {
      EXT_color_buffer_float: !!gl.getExtension('EXT_color_buffer_float'),
      EXT_color_buffer_half_float: !!gl.getExtension('EXT_color_buffer_half_float'),
      OES_texture_float_linear: !!gl.getExtension('OES_texture_float_linear'),
      EXT_float_blend: !!gl.getExtension('EXT_float_blend'),
      EXT_disjoint_timer_query_webgl2: !!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    },
  };
}

export function makeTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

/** Render `src` texture through a program into an RGBA8 framebuffer of w×h and read it back. */
export function renderPass(
  e: GlEnv,
  prog: WebGLProgram,
  src: WebGLTexture,
  w: number,
  h: number,
  uniforms: (gl: WebGL2RenderingContext, p: WebGLProgram) => void,
  read?: { x: number; y: number; w: number; h: number; out: Uint8Array },
): void {
  const { gl } = e;
  const target = makeTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete 0x' + st.toString(16));
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(gl.getUniformLocation(prog, 'uSrc'), 0);
  uniforms(gl, prog);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  if (read) gl.readPixels(read.x, read.y, read.w, read.h, gl.RGBA, gl.UNSIGNED_BYTE, read.out);
  else gl.finish();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(target);
}

/** Upload a sub-rectangle of an ImageBitmap with UNPACK_SKIP_* (WebGL2 only path). */
export function uploadSubRect(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  src: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  } finally {
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
}
