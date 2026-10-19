// Stencil PDF at 1:1 (plan 5.3): the ink mask as a grey image placed at the design's
// physical width, centred on an A4 page (or a larger page if the design does not fit), with
// a 10 mm scale bar to check the print size and an optional mirrored copy for transfer paper.
// Hand-written PDF 1.4: one page, one Flate-compressed image, Helvetica for the labels.

const MM = 72 / 25.4;
const A4 = [210, 297];
const MARGIN = 10;

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(await out);
}

export interface StencilOptions {
  widthCm: number;
  mirror: boolean;
  /** Line printed under the design, ASCII only (standard Helvetica encoding). */
  label?: string;
}

/**
 * gray: one byte per pixel, 0 = ink, 255 = paper. Returns the PDF bytes and the page size, mm.
 */
export async function stencilPdf(gray: Uint8Array, w: number, h: number, o: StencilOptions): Promise<{ pdf: Uint8Array; pageMm: [number, number]; designMm: [number, number] }> {
  const dw = o.widthCm * 10, dh = (dw * h) / w;
  const pw = Math.max(A4[0], dw + 2 * MARGIN), ph = Math.max(A4[1], dh + 2 * MARGIN + 20);
  let px = gray;
  if (o.mirror) {
    px = new Uint8Array(gray.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = gray[y * w + (w - 1 - x)];
  }
  const img = await deflate(px);
  // Design centred horizontally, top-aligned under the margin; PDF y grows upwards.
  const x0 = (pw - dw) / 2, y0 = ph - MARGIN - dh;
  const f = (v: number) => (v * MM).toFixed(3);
  const bar = [x0, y0 - 8];
  const label = (o.label ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/[()\\]/g, '\\$&');
  const content = [
    `q ${f(dw)} 0 0 ${f(dh)} ${f(x0)} ${f(y0)} cm /Im0 Do Q`,
    // 10 mm scale bar with end ticks.
    `0 g 0.5 w ${f(bar[0])} ${f(bar[1])} m ${f(bar[0] + 10)} ${f(bar[1])} l S`,
    `${f(bar[0])} ${f(bar[1] - 1.5)} m ${f(bar[0])} ${f(bar[1] + 1.5)} l S`,
    `${f(bar[0] + 10)} ${f(bar[1] - 1.5)} m ${f(bar[0] + 10)} ${f(bar[1] + 1.5)} l S`,
    `BT /F1 8 Tf ${f(bar[0] + 12)} ${f(bar[1] - 1)} Td (10 mm. Design ${(dw / 10).toFixed(1)} x ${(dh / 10).toFixed(1)} cm${o.mirror ? ', mirrored' : ''}. ${label}) Tj ET`,
  ].join('\n');
  const objs: Array<Uint8Array | string> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`,
    img,
    content,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const enc = new TextEncoder(), parts: Uint8Array[] = [], offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  objs.forEach((ob, i) => {
    offsets.push(len);
    push(`${i + 1} 0 obj\n`);
    if (i === 3) {
      push(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.length} >>\nstream\n`);
      push(img);
      push('\nendstream');
    } else if (i === 4) {
      const c = enc.encode(content);
      push(`<< /Length ${c.length} >>\nstream\n`);
      push(c);
      push('\nendstream');
    } else push(ob as string);
    push('\nendobj\n');
  });
  const xref = len;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join(''));
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const pdf = new Uint8Array(len);
  let at = 0;
  for (const p of parts) { pdf.set(p, at); at += p.length; }
  return { pdf, pageMm: [Math.round(pw), Math.round(ph)], designMm: [Math.round(dw * 10) / 10, Math.round(dh * 10) / 10] };
}
