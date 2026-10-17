import type { NativePdfAttachment } from './native-pdf';

export const PDF_FIXTURE_MARKER = 'VARRO-PDF-7C4E29';

// Complete, deterministic one-page documents. No parser, renderer, or user file is needed.
export function nativePdfFixture(kind: 'text' | 'image' = 'text'): NativePdfAttachment {
  const stream =
    kind === 'text'
      ? `BT /F1 18 Tf 40 100 Td (${PDF_FIXTURE_MARKER}) Tj ET\n`
      : 'q 120 0 0 120 30 30 cm /Im1 Do Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << ${kind === 'text' ? '/Font << /F1 5 0 R >>' : '/XObject << /Im1 5 0 R >>'} >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    kind === 'text'
      ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
      : '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n00FF00>\nendstream',
  ];
  let document = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(document.length);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = document.length;
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  document += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return {
    id: `pdf-${kind}`,
    filename: `${kind}.pdf`,
    mime: 'application/pdf',
    size: document.length,
    url: `data:application/pdf;base64,${btoa(document)}`,
  };
}
