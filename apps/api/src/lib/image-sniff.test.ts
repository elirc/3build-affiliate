import { describe, expect, it } from 'vitest';
import { readDimensions, sniffImage } from './image-sniff';

/** Minimal valid-enough headers for each accepted format. */
const png = (w = 1200, h = 628) => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

const gif = (w = 300, h = 250) => {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};

const webp = () => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8 ', 12, 'ascii');
  b.writeUInt16LE(728, 26);
  b.writeUInt16LE(90, 28);
  return b;
};

/**
 * SOI followed immediately by a start-of-frame segment:
 *
 *   FFD8            start of image
 *   FFC0            SOF0
 *   0011            segment length
 *   08              sample precision
 *   HHHH WWWW       height then width -- JPEG puts them in that order
 */
const jpeg = (w = 800, h = 600) => {
  const b = Buffer.alloc(20);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[3] = 0xc0;
  b.writeUInt16BE(11, 4);
  b[6] = 8;
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
};

describe('sniffImage', () => {
  it('identifies the four accepted formats', () => {
    expect(sniffImage(png())).toEqual({ type: 'png', mime: 'image/png' });
    expect(sniffImage(gif())).toEqual({ type: 'gif', mime: 'image/gif' });
    expect(sniffImage(webp())).toEqual({ type: 'webp', mime: 'image/webp' });
    expect(sniffImage(jpeg())).toEqual({ type: 'jpeg', mime: 'image/jpeg' });
  });

  it('rejects SVG', () => {
    // Deliberate. SVG is XML, it can carry <script>, and browsers execute it.
    // An "image" that runs code is stored XSS on whatever origin serves it.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(sniffImage(svg)).toBeNull();
  });

  it('rejects a script renamed to look like an image', () => {
    // The whole reason this module exists: extension and Content-Type are
    // supplied by the uploader and prove nothing.
    expect(sniffImage(Buffer.from('<?php system($_GET["c"]); ?>'))).toBeNull();
    expect(sniffImage(Buffer.from('#!/bin/sh\nrm -rf /'))).toBeNull();
  });

  it('rejects a WAV file that shares the RIFF container', () => {
    // Checking only for "RIFF" would accept audio as an image.
    const wav = Buffer.alloc(12);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffImage(wav)).toBeNull();
  });

  it('rejects empty and truncated input', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('rejects a PNG signature with one byte wrong', () => {
    const bad = png();
    bad[3] = 0x00;
    expect(sniffImage(bad)).toBeNull();
  });
});

describe('readDimensions', () => {
  it('reads PNG dimensions', () => {
    expect(readDimensions(png(1200, 628), 'png')).toEqual({
      width: 1200,
      height: 628,
    });
  });

  it('reads GIF dimensions', () => {
    expect(readDimensions(gif(300, 250), 'gif')).toEqual({ width: 300, height: 250 });
  });

  it('reads lossy WebP dimensions', () => {
    expect(readDimensions(webp(), 'webp')).toEqual({ width: 728, height: 90 });
  });

  it('walks JPEG segments to the start-of-frame', () => {
    // JPEG is the awkward one: there is no fixed offset, so the dimensions
    // have to be found by walking the segment markers.
    expect(readDimensions(jpeg(800, 600), 'jpeg')).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('returns null rather than guessing on a truncated header', () => {
    // Dimensions are for display convenience. Not knowing them is survivable;
    // inventing them is not.
    expect(readDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'png')).toBeNull();
    expect(readDimensions(Buffer.alloc(4), 'jpeg')).toBeNull();
  });
});
