// GLSL twins of src/core/color.ts and src/core/view.ts. Constants must match:
// the parity self-test compares GPU output with the CPU reference pixel by pixel.

export const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp int;
const float EPS = 216.0 / 24389.0;
const float KAPPA = 24389.0 / 27.0;
float lin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float fl(float t) { return t > EPS ? pow(t, 1.0 / 3.0) : (KAPPA * t + 16.0) / 116.0; }
vec3 srgbToLab(vec3 c) {
  vec3 l = vec3(lin(c.r), lin(c.g), lin(c.b));
  float x = dot(vec3(0.4124, 0.3576, 0.1805), l) / 0.95047;
  float y = dot(vec3(0.2126, 0.7152, 0.0722), l);
  float z = dot(vec3(0.0193, 0.1192, 0.9505), l) / 1.08883;
  float fx = fl(x), fy = fl(y), fz = fl(z);
  return vec3(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz));
}
float finv(float v) { float v3 = v * v * v; return v3 > EPS ? v3 : (116.0 * v - 16.0) / KAPPA; }
float enc(float c) {
  c = max(c, 0.0);
  return clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055, 0.0, 1.0);
}
vec3 labToSrgb(vec3 lab) {
  float fy = (lab.x + 16.0) / 116.0, fx = fy + lab.y / 500.0, fz = fy - lab.z / 200.0;
  float x = finv(fx) * 0.95047, y = finv(fy), z = finv(fz) * 1.08883;
  return vec3(
    enc(3.2406 * x - 1.5372 * y - 0.4986 * z),
    enc(-0.9689 * x + 1.8758 * y + 0.0415 * z),
    enc(0.0557 * x - 0.204 * y + 1.057 * z));
}
float luma601(vec3 c) { return dot(vec3(0.299, 0.587, 0.114), c * 255.0); }
`;

/** Analysis buffer: RGBA8 = (L*·2.55, a*+128, b*+128, luma601). Read back for histograms. */
export const FRAG_ANALYZE = `${COMMON}
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  vec3 lab = srgbToLab(c);
  outColor = vec4(clamp(lab.x * 2.55, 0.0, 255.0), clamp(lab.y + 128.0, 0.0, 255.0), clamp(lab.z + 128.0, 0.0, 255.0), luma601(c)) / 255.0;
}`;

/** One direction of a separable Gaussian. */
export const FRAG_BLUR = `${COMMON}
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform float uSigma;
uniform int uRadius;
out vec4 outColor;
void main() {
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  for (int i = -32; i <= 32; i++) {
    if (i < -uRadius || i > uRadius) continue;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    acc += w * texture(uSrc, vUv + uStep * float(i));
    ws += w;
  }
  outColor = acc / ws;
}`;

export const FRAG_VIEW = `${COMMON}
in vec2 vUv;
uniform sampler2D uSrc;
uniform int uView;          // 0 original, 1 values, 2 notan, 3 temperature, 4 highlight
uniform int uScale;         // 0 L*·2.55, 1 luma601
uniform float uThr[19];
uniform int uNThr;
uniform float uLevelGray[20];
uniform float uLevelL[20];
uniform bool uShowHue;
uniform int uHighlight;
uniform float uNotanThr[2];
uniform int uNotanN;
uniform bool uInvert;
uniform float uNeutral;
uniform float uSpread;
uniform int uTempStyle;     // 0 map, 1 shaded, 2 two colours
uniform vec3 uHlTarget;
uniform float uHlTol;
uniform int uHlMode;        // 0 highlight, 1 outline
uniform vec2 uStep;         // outline neighbour step in uv; also the dash pixel size
uniform vec4 uRect;         // image rect in output space, top-left origin: x, y, w, h
uniform bool uFlip;
uniform vec4 uBg;
out vec4 outColor;

const float FADE_KEEP = 0.3;
const float FADE_TO = 230.0 / 255.0;

vec3 tempColor(float t) {
  t = clamp(t, -1.0, 1.0);
  vec3 c0 = vec3(48.0, 116.0, 235.0), c1 = vec3(178.0, 159.0, 181.0), c2 = vec3(255.0, 180.0, 120.0), c3 = vec3(255.0, 40.0, 0.0);
  vec3 c = t <= 0.0 ? mix(c0, c1, t + 1.0) : (t <= 0.5 ? mix(c1, c2, t / 0.5) : mix(c2, c3, (t - 0.5) / 0.5));
  return c / 255.0;
}

// CIEDE2000, twin of deltaE2000() in src/core/colorinfo.ts.
float hueDeg(float b, float a) {
  if (a == 0.0 && b == 0.0) return 0.0;
  float h = degrees(atan(b, a));
  return h < 0.0 ? h + 360.0 : h;
}
const float P25_7 = 6103515625.0;
float de2000(vec3 l1, vec3 l2) {
  float C1 = length(l1.yz), C2 = length(l2.yz), Cm = 0.5 * (C1 + C2), Cm7 = pow(Cm, 7.0);
  float G = 0.5 * (1.0 - sqrt(Cm7 / (Cm7 + P25_7)));
  float a1p = (1.0 + G) * l1.y, a2p = (1.0 + G) * l2.y;
  float C1p = length(vec2(a1p, l1.z)), C2p = length(vec2(a2p, l2.z));
  float h1p = hueDeg(l1.z, a1p), h2p = hueDeg(l2.z, a2p);
  float dLp = l2.x - l1.x, dCp = C2p - C1p, dhp = 0.0;
  bool chroma = C1p * C2p != 0.0;
  if (chroma) {
    dhp = h2p - h1p;
    if (dhp > 180.0) dhp -= 360.0;
    else if (dhp < -180.0) dhp += 360.0;
  }
  float dHp = 2.0 * sqrt(C1p * C2p) * sin(radians(dhp * 0.5));
  float Lmp = 0.5 * (l1.x + l2.x), Cmp = 0.5 * (C1p + C2p), hmp = h1p + h2p;
  if (chroma) {
    if (abs(h1p - h2p) <= 180.0) hmp *= 0.5;
    else hmp = hmp < 360.0 ? (hmp + 360.0) * 0.5 : (hmp - 360.0) * 0.5;
  }
  float T = 1.0 - 0.17 * cos(radians(hmp - 30.0)) + 0.24 * cos(radians(2.0 * hmp))
    + 0.32 * cos(radians(3.0 * hmp + 6.0)) - 0.2 * cos(radians(4.0 * hmp - 63.0));
  float q = (hmp - 275.0) / 25.0, dTheta = 30.0 * exp(-q * q);
  float Cmp7 = pow(Cmp, 7.0), Rc = 2.0 * sqrt(Cmp7 / (Cmp7 + P25_7));
  float L50 = (Lmp - 50.0) * (Lmp - 50.0);
  float Sl = 1.0 + 0.015 * L50 / sqrt(20.0 + L50), Sc = 1.0 + 0.045 * Cmp, Sh = 1.0 + 0.015 * Cmp * T;
  float Rt = -sin(radians(2.0 * dTheta)) * Rc;
  float x = dLp / Sl, y = dCp / Sc, z = dHp / Sh;
  return sqrt(max(0.0, x * x + y * y + z * z + Rt * y * z));
}

// Outside the image counts as matching: no contour along the frame.
// Called in non-uniform control flow, where implicit derivatives are undefined and a
// GPU may pick a blurred mip level (Apple GPU did): sample level 0 explicitly.
bool matchAt(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return true;
  return de2000(srgbToLab(textureLod(uSrc, uv, 0.0).rgb), uHlTarget) <= uHlTol;
}

void main() {
  vec2 p = vec2(vUv.x, uFlip ? 1.0 - vUv.y : vUv.y);
  vec2 uv = (p - uRect.xy) / uRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { outColor = uBg; return; }
  vec3 c = texture(uSrc, uv).rgb;
  vec3 o = c;
  if (uView != 0) {
    vec3 lab = srgbToLab(c);
    float tone = uScale == 1 ? luma601(c) : lab.x * 2.55;
    if (uView == 4) {
      bool m = de2000(lab, uHlTarget) <= uHlTol;
      if (uHlMode == 0) {
        if (!m) o = labToSrgb(vec3(lab.x, 0.0, 0.0)) * FADE_KEEP + FADE_TO * (1.0 - FADE_KEEP);
      } else if (m && (!matchAt(uv - vec2(uStep.x, 0.0)) || !matchAt(uv + vec2(uStep.x, 0.0))
          || !matchAt(uv - vec2(0.0, uStep.y)) || !matchAt(uv + vec2(0.0, uStep.y)))) {
        ivec2 ip = ivec2(floor(uv / uStep));
        o = vec3(((ip.x + ip.y) / 4) % 2 == 1 ? 0.0 : 1.0);
      }
    } else if (uView == 1) {
      int lev = 0;
      for (int i = 0; i < 19; i++) { if (i >= uNThr) break; if (tone > uThr[i]) lev++; }
      o = uShowHue ? labToSrgb(vec3(uLevelL[lev], lab.yz)) : vec3(uLevelGray[lev] / 255.0);
      if (uHighlight >= 0 && lev != uHighlight) o = o * FADE_KEEP + FADE_TO * (1.0 - FADE_KEEP);
    } else if (uView == 2) {
      int lev = 0;
      for (int i = 0; i < 2; i++) { if (i >= uNotanN) break; if (tone > uNotanThr[i]) lev++; }
      if (uInvert) lev = uNotanN - lev;
      float g = uNotanN == 2 ? (lev == 0 ? 0.0 : (lev == 1 ? 119.0 : 255.0)) : (lev == 0 ? 0.0 : 255.0);
      o = vec3(g / 255.0);
    } else {
      float t = (lab.y * 0.5 + lab.z * 0.8660254037844386 - uNeutral) / uSpread;
      if (uTempStyle == 2) o = t > 0.0 ? vec3(250.0, 130.0, 60.0) / 255.0 : vec3(60.0, 120.0, 230.0) / 255.0;
      else {
        vec3 m = tempColor(t);
        o = uTempStyle == 1 ? labToSrgb(vec3(lab.x, srgbToLab(floor(m * 255.0 + 0.5) / 255.0).yz)) : m;
      }
    }
  }
  outColor = vec4(o, 1.0);
}`;
