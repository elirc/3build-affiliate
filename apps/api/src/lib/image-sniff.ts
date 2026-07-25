/**
 * Identifies an image by its bytes, not by what the uploader claimed.
 *
 * Filenames and Content-Type headers are supplied by the client and mean
 * nothing. `payload.php` renamed to `payload.png` with `image/png` in the
 * header is trivially easy; the only thing that cannot be faked is what the
 * file actually starts with.
 */

export type SniffedImage = 'png' | 'jpeg' | 'gif' | 'webp';

interface Signature {
  type: SniffedImage;
  mime: string;
  test: (b: Buffer) => boolean;
}

const SIGNATURES: Signature[] = [
  {
    type: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 && // P
      b[2] === 0x4e && // N
      b[3] === 0x47 && // G
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    type: 'jpeg',
    mime: 'image/jpeg',
    // Start-of-image marker. The third byte is the first segment marker and is
    // always 0xFF for a valid JPEG.
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'gif',
    mime: 'image/gif',
    test: (b) =>
      b.length >= 6 &&
      b.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null,
  },
  {
    type: 'webp',
    mime: 'image/webp',
    // RIFF container with a WEBP fourcc at offset 8. Checking only "RIFF"
    // would also accept a WAV file.
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

export interface SniffResult {
  type: SniffedImage;
  mime: string;
}

/**
 * Returns null for anything not on the list, which deliberately excludes SVG.
 *
 * SVG is XML, it can carry <script>, and browsers execute it when the file is
 * served directly or embedded via <object>. An "image" format that runs code
 * is a stored-XSS vector on whatever origin serves it, so it is not accepted
 * however convenient vector logos would be.
 */
export function sniffImage(bytes: Buffer): SniffResult | null {
  for (const sig of SIGNATURES) {
    if (sig.test(bytes)) return { type: sig.type, mime: sig.mime };
  }
  return null;
}

/**
 * Reads intrinsic dimensions from the header bytes.
 *
 * Enough for the four formats we accept, and avoids pulling in an image
 * library for two numbers. Returns null rather than guessing when the header
 * is truncated or the variant is unusual -- dimensions are for display
 * convenience, not correctness, so not knowing them is survivable.
 */
export function readDimensions(
  bytes: Buffer,
  type: SniffedImage
): { width: number; height: number } | null {
  try {
    if (type === 'png' && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }

    if (type === 'gif' && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }

    if (type === 'webp' && bytes.length >= 30) {
      const format = bytes.subarray(12, 16).toString('ascii');
      if (format === 'VP8 ') {
        return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
      }
      if (format === 'VP8L') {
        const bits = bytes.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (format === 'VP8X') {
        return {
          width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1,
        };
      }
      return null;
    }

    if (type === 'jpeg') {
      // Walk the segment markers to the start-of-frame, which is the only
      // place the dimensions live. JPEG has no fixed header offset.
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1]!;
        // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {
            height: bytes.readUInt16BE(offset + 5),
            width: bytes.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + bytes.readUInt16BE(offset + 2);
      }
      return null;
    }
  } catch {
    // A truncated or malformed header. Not knowing the size is fine.
    return null;
  }
  return null;
}
