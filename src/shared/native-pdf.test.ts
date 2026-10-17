import { describe, expect, it } from 'vitest';
import {
  getPdfDataUrlSize,
  getPdfInputSupport,
  isNativePdfAttachment,
  isPdfBytes,
  MAX_NATIVE_PDF_TOTAL_BYTES,
} from './native-pdf';
import { nativePdfFixture } from './native-pdf.test-support';
import { parseExtensionMessage } from './extension-message';

describe('native PDF validation', () => {
  it.each(['text', 'image'] as const)('retains exact bytes of the %s document', (kind) => {
    const pdf = nativePdfFixture(kind);
    expect(isNativePdfAttachment(pdf)).toBe(true);
    expect(getPdfDataUrlSize(pdf.url)).toBe(pdf.size);
    expect(isPdfBytes(new TextEncoder().encode(atob(pdf.url.split(',')[1]!)))).toBe(true);
  });

  it.each(['', 'JVBERi0', 'JVBERi0===', 'JVBE Ri0=', 'JVBERi0_', '%%%%', 'bm90IGEgcGRm'])(
    'rejects malformed base64 or headers: %s',
    (encoded) => {
      expect(getPdfDataUrlSize(`data:application/pdf;base64,${encoded}`)).toBeNull();
    }
  );

  it('rejects mismatched sizes, MIME, filenames and invalid sequences', () => {
    const pdf = nativePdfFixture();
    for (const change of [
      { size: pdf.size + 1 },
      { size: 1.5 },
      { mime: 'text/plain' },
      { filename: '' },
      { filename: 'a'.repeat(513) },
      { attachmentSequence: -1 },
      { attachmentSequence: 1.5 },
    ])
      expect(isNativePdfAttachment({ ...pdf, ...change })).toBe(false);
    expect(isNativePdfAttachment({ ...pdf, filename: 'a'.repeat(512) })).toBe(true);
  });

  it('bounds decoded bytes without claiming to parse document integrity', () => {
    const headerOnly = 'data:application/pdf;base64,JVBERi0=';
    // A header is a transport check. Corrupt/encrypted documents remain a provider concern.
    expect(getPdfDataUrlSize(headerOnly)).toBe(5);
    const encoded = btoa('%PDF-' + ' '.repeat(MAX_NATIVE_PDF_TOTAL_BYTES - 5));
    expect(getPdfDataUrlSize(`data:application/pdf;base64,${encoded}`)).toBe(
      MAX_NATIVE_PDF_TOTAL_BYTES
    );
    expect(getPdfDataUrlSize(`data:application/pdf;base64,${encoded}AAAA`)).toBeNull();
  });

  it('rejects an aggregate over 20 MiB even when each PDF is within the limit', () => {
    const size = MAX_NATIVE_PDF_TOTAL_BYTES / 2 + 1;
    const pdf = {
      ...nativePdfFixture(),
      size,
      url: `data:application/pdf;base64,${btoa('%PDF-' + ' '.repeat(size - 5))}`,
    };
    expect(isNativePdfAttachment(pdf)).toBe(true);
    expect(parseExtensionMessage({ type: 'pdfs/picked', payload: [pdf] })).not.toBeNull();
    expect(
      parseExtensionMessage({ type: 'pdfs/picked', payload: [pdf, { ...pdf, id: 'second' }] })
    ).toBeNull();
  });

  it.each([
    [['text', 'pdf'], 'supported'],
    [['text'], 'unsupported'],
    [{ pdf: true }, 'supported'],
    [{ pdf: false }, 'unsupported'],
    [undefined, 'unknown'],
    [{ attachment: true }, 'unknown'],
    [['pdf', false], 'unknown'],
    [{ pdf: 'true' }, 'unknown'],
  ])('reads advertised PDF capability from %j as %s', (input, expected) => {
    expect(getPdfInputSupport(input)).toBe(expected);
  });
});
