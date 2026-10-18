// WebGL2 renderer living in the engine Worker. One context draws both the
// off-screen passes (smoothing, analysis buffer, parity read-back) and, when the
// page hands over its <canvas>, the on-screen view.

import type { ViewPlan, Smoothing } from '../core/view';
import { MAX_LEVELS } from '../core/view';
import { FRAG_ANALYZE, FRAG_BLUR, FRAG_VIEW, VERT } from './shaders';

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

/** Smoothing sigma in pixels of a 1600 px working copy; scaled with its size. */
export const SMOOTH_SIGMA: Record<Smoothing, number> = { 0: 0, 1: 1.5, 2: 4 };

/** Where the view lands: on screen (letterboxed, with background) or into pixels at work size. */
export interface ScreenRect { x: number; y: number; w: number; h: number }

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
  return s;
}

class Program {
  readonly p: WebGLProgram;
  private loc = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, frag: string) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    this.p = p;
  }
  u(name: string): WebGLUniformLocation | null {
    if (!this.loc.has(name)) this.loc.set(name, this.gl.getUniformLocation(this.p, name));
    return this.loc.get(name)!;
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  lost = false;
  private analyzeP: Program;
  private blurP: Program;
  private viewP: Program;
  private src: WebGLTexture | null = null;
  private smoothed = new Map<number, Target>();
  private tmp: Target | null = null;
  private analysis: Target | null = null;
  private pixels: Target | null = null;
  w = 0;
  h = 0;

  constructor(readonly canvas: OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, depth: false, stencil: false, alpha: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 недоступен в Worker');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.analyzeP = new Program(gl, FRAG_ANALYZE);
    this.blurP = new Program(gl, FRAG_BLUR);
    this.viewP = new Program(gl, FRAG_VIEW);
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  private texture(w: number, h: number, mip = false): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w && h) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  private target(w: number, h: number, mip = false): Target {
    const gl = this.gl, tex = this.texture(w, h, mip), fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private drop(t: Target | null) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  /** Releases everything tied to the current photo. */
  clear() {
    if (this.src) this.gl.deleteTexture(this.src);
    this.src = null;
    for (const t of this.smoothed.values()) this.drop(t);
    this.smoothed.clear();
    [this.tmp, this.analysis, this.pixels].forEach((t) => this.drop(t));
    this.tmp = this.analysis = this.pixels = null;
    this.w = this.h = 0;
  }

  /** Uploads the working copy and builds its mip chain (the on-screen pyramid). */
  setSource(bitmap: ImageBitmap) {
    this.clear();
    const gl = this.gl;
    this.w = bitmap.width;
    this.h = bitmap.height;
    this.src = this.texture(0, 0, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  private draw(p: Program, src: WebGLTexture, dst: Target | null, vw: number, vh: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, vw, vh);
    gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(p.u('uSrc'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Source texture for a smoothing level; blurred copies are cached per photo. */
  sourceFor(level: Smoothing): WebGLTexture {
    if (!this.src) throw new Error('нет изображения');
    if (!level) return this.src;
    const cached = this.smoothed.get(level);
    if (cached) return cached.tex;
    const gl = this.gl, sigma = Math.max(0.5, (SMOOTH_SIGMA[level] * Math.max(this.w, this.h)) / 1600);
    const radius = Math.min(32, Math.ceil(sigma * 3));
    this.tmp ??= this.target(this.w, this.h);
    const out = this.target(this.w, this.h, true);
    for (const [src, dst, step] of [[this.src, this.tmp, [1 / this.w, 0]], [this.tmp.tex, out, [0, 1 / this.h]]] as const) {
      gl.useProgram(this.blurP.p);
      gl.uniform2f(this.blurP.u('uStep'), step[0], step[1]);
      gl.uniform1f(this.blurP.u('uSigma'), sigma);
      gl.uniform1i(this.blurP.u('uRadius'), radius);
      this.draw(this.blurP, src, dst, this.w, this.h);
    }
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.smoothed.set(level, out);
    return out.tex;
  }

  private read(t: Target): Uint8Array {
    const gl = this.gl, buf = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return buf;
  }

  /** Analysis buffer (L*·2.55, a*+128, b*+128, luma) at work size, read back for histograms. */
  analyze(level: Smoothing): Uint8Array {
    const src = this.sourceFor(level);
    this.analysis ??= this.target(this.w, this.h);
    this.draw(this.analyzeP, src, this.analysis, this.w, this.h);
    return this.read(this.analysis);
  }

  private setViewUniforms(plan: ViewPlan, rect: ScreenRect, flip: boolean, bg: [number, number, number]) {
    const gl = this.gl, p = this.viewP;
    gl.useProgram(p.p);
    const thr = new Float32Array(MAX_LEVELS - 1), gray = new Float32Array(MAX_LEVELS), L = new Float32Array(MAX_LEVELS);
    thr.set(plan.thresholds.slice(0, MAX_LEVELS - 1));
    gray.set(plan.levelGray.slice(0, MAX_LEVELS));
    L.set(plan.levelL.slice(0, MAX_LEVELS));
    const nthr = new Float32Array(2);
    nthr.set(plan.notanThresholds.slice(0, 2));
    gl.uniform1i(p.u('uView'), plan.view);
    gl.uniform1i(p.u('uScale'), plan.scale);
    gl.uniform1fv(p.u('uThr'), thr);
    gl.uniform1i(p.u('uNThr'), Math.min(MAX_LEVELS - 1, plan.thresholds.length));
    gl.uniform1fv(p.u('uLevelGray'), gray);
    gl.uniform1fv(p.u('uLevelL'), L);
    gl.uniform1i(p.u('uShowHue'), plan.showHue ? 1 : 0);
    gl.uniform1i(p.u('uHighlight'), plan.highlight);
    gl.uniform1fv(p.u('uNotanThr'), nthr);
    gl.uniform1i(p.u('uNotanN'), plan.notanThresholds.length);
    gl.uniform1i(p.u('uInvert'), plan.invert ? 1 : 0);
    gl.uniform1f(p.u('uNeutral'), plan.neutral);
    gl.uniform1f(p.u('uSpread'), plan.spread);
    gl.uniform1i(p.u('uTempStyle'), plan.tempStyle);
    gl.uniform4f(p.u('uRect'), rect.x, rect.y, rect.w, rect.h);
    gl.uniform1i(p.u('uFlip'), flip ? 1 : 0);
    gl.uniform4f(p.u('uBg'), bg[0] / 255, bg[1] / 255, bg[2] / 255, 1);
  }

  /** Draws the view into the canvas back buffer; rect is the image rect in 0..1 canvas units. */
  renderScreen(plan: ViewPlan, level: Smoothing, rect: ScreenRect, bg: [number, number, number]) {
    const src = this.sourceFor(level);
    this.setViewUniforms(plan, rect, true, bg);
    this.draw(this.viewP, src, null, this.canvas.width, this.canvas.height);
  }

  /** Renders the view at work size and reads it back (parity tests, export of the working copy). */
  renderPixels(plan: ViewPlan, level: Smoothing): Uint8Array {
    const src = this.sourceFor(level);
    this.pixels ??= this.target(this.w, this.h);
    this.setViewUniforms(plan, { x: 0, y: 0, w: 1, h: 1 }, false, [0, 0, 0]);
    this.draw(this.viewP, src, this.pixels, this.w, this.h);
    return this.read(this.pixels);
  }

  /** The working copy exactly as the GPU sees it (input for the CPU reference). */
  readSource(level: Smoothing): Uint8Array {
    return this.renderPixels({
      view: 0, scale: 0, thresholds: [], levelGray: [], levelL: [], showHue: false, highlight: -1,
      notanThresholds: [], invert: false, neutral: 0, spread: 1, tempStyle: 0,
    }, level);
  }

  /** Blocks until the GPU has finished; used only to time frames honestly. */
  finish() {
    this.gl.finish();
  }
}
