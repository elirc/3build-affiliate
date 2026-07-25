import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
} from './factories';

/** A tiny but structurally valid PNG. */
function pngBytes(width = 728, height = 90): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** Builds a multipart body by hand so the test exercises the real parser. */
function multipartBody(
  fields: Record<string, string>,
  file?: { field: string; filename: string; contentType: string; bytes: Buffer }
) {
  const boundary = `----test${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; ` +
          `filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
      ),
      file.bytes,
      Buffer.from('\r\n')
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('creative assets', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function scenario() {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id, 'APPROVED');
    const stranger = await makeAffiliate();

    return {
      brand,
      campaign,
      affiliate,
      stranger,
      brandAuth: await login(app, brand.email),
      affiliateAuth: await login(app, affiliate.email),
      strangerAuth: await login(app, stranger.email),
    };
  }

  function upload(
    s: Awaited<ReturnType<typeof scenario>>,
    bytes: Buffer,
    filename = 'banner.png',
    contentType = 'image/png'
  ) {
    const body = multipartBody(
      { name: 'Leaderboard' },
      { field: 'file', filename, contentType, bytes }
    );
    return app.inject({
      method: 'POST',
      url: `/api/brand/campaigns/${s.campaign.id}/creatives`,
      headers: { ...s.brandAuth.authHeader, ...body.headers },
      payload: body.payload,
    });
  }

  it('accepts a PNG and records its dimensions', async () => {
    const s = await scenario();
    const res = await upload(s, pngBytes(728, 90));

    expect(res.statusCode).toBe(201);
    const asset = res.json() as { width: number; height: number; url: string };
    expect(asset.width).toBe(728);
    expect(asset.height).toBe(90);
    // The stored key is generated, never the uploader's filename.
    expect(asset.url).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  it('rejects a script renamed to .png with an image content type', async () => {
    // The attack the sniffing exists for: both the filename and the
    // Content-Type claim this is an image, and neither is evidence.
    const s = await scenario();
    const res = await upload(
      s,
      Buffer.from('<?php system($_GET["cmd"]); ?>'),
      'innocent.png',
      'image/png'
    );

    expect(res.statusCode).toBe(400);
    expect(await prisma.creativeAsset.count()).toBe(0);
  });

  it('rejects SVG', async () => {
    const s = await scenario();
    const res = await upload(
      s,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      'logo.svg',
      'image/svg+xml'
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty file', async () => {
    const s = await scenario();
    const res = await upload(s, Buffer.alloc(0));
    expect(res.statusCode).toBe(400);
  });

  it('lets an approved affiliate list and download', async () => {
    const s = await scenario();
    const created = (await upload(s, pngBytes())).json() as { id: string };

    const list = await app.inject({
      method: 'GET',
      url: `/api/affiliate/campaigns/${s.campaign.id}/creatives`,
      headers: s.affiliateAuth.authHeader,
    });
    expect(list.json()).toHaveLength(1);

    const file = await app.inject({
      method: 'GET',
      url: `/api/creatives/${created.id}/file`,
      headers: s.affiliateAuth.authHeader,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('image/png');
    // Set so a browser cannot be talked into treating these bytes as
    // something executable.
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses an affiliate who has not been approved', async () => {
    // Creatives are unreleased marketing material. A competitor should not be
    // able to enumerate a brand's next campaign by signing up.
    const s = await scenario();
    const created = (await upload(s, pngBytes())).json() as { id: string };

    const list = await app.inject({
      method: 'GET',
      url: `/api/affiliate/campaigns/${s.campaign.id}/creatives`,
      headers: s.strangerAuth.authHeader,
    });
    expect(list.statusCode).toBe(403);

    const file = await app.inject({
      method: 'GET',
      url: `/api/creatives/${created.id}/file`,
      headers: s.strangerAuth.authHeader,
    });
    expect(file.statusCode).toBe(403);
  });

  it('refuses another brand', async () => {
    const s = await scenario();
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    const res = await app.inject({
      method: 'GET',
      url: `/api/brand/campaigns/${s.campaign.id}/creatives`,
      headers: otherAuth.authHeader,
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication to download', async () => {
    const s = await scenario();
    const created = (await upload(s, pngBytes())).json() as { id: string };

    const res = await app.inject({
      method: 'GET',
      url: `/api/creatives/${created.id}/file`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('deletes an asset', async () => {
    const s = await scenario();
    const created = (await upload(s, pngBytes())).json() as { id: string };

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/brand/creatives/${created.id}`,
      headers: s.brandAuth.authHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(await prisma.creativeAsset.count()).toBe(0);

    // And the bytes are no longer reachable.
    const file = await app.inject({
      method: 'GET',
      url: `/api/creatives/${created.id}/file`,
      headers: s.brandAuth.authHeader,
    });
    expect(file.statusCode).toBe(404);
  });

  it('refuses to delete another brand’s asset', async () => {
    const s = await scenario();
    const created = (await upload(s, pngBytes())).json() as { id: string };
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/brand/creatives/${created.id}`,
      headers: otherAuth.authHeader,
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.creativeAsset.count()).toBe(1);
  });
});
