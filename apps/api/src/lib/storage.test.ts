import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalDiskStorage } from './storage';

describe('LocalDiskStorage', () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    storage = new LocalDiskStorage(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips a file', async () => {
    const bytes = Buffer.from('hello');
    const { key, sizeBytes } = await storage.put(bytes, 'png');

    expect(sizeBytes).toBe(5);
    expect(await storage.get(key)).toEqual(bytes);
  });

  it('never reuses a key', async () => {
    // Two brands uploading "banner.png" must not overwrite each other.
    const a = await storage.put(Buffer.from('a'), 'png');
    const b = await storage.put(Buffer.from('b'), 'png');

    expect(a.key).not.toBe(b.key);
    expect(await storage.get(a.key)).toEqual(Buffer.from('a'));
  });

  it('generates its own name rather than trusting one', async () => {
    const { key } = await storage.put(Buffer.from('x'), 'png');
    expect(key).toMatch(/^[0-9a-f]{32}\.png$/);
  });

  it('refuses a key that escapes the root', async () => {
    // Cannot happen with generated keys, which is exactly why the check has to
    // be here rather than assumed at every call site.
    await expect(storage.get('../../../etc/passwd')).rejects.toThrow(/outside the root/);
    await expect(storage.delete('..\\..\\windows\\system32')).rejects.toThrow(
      /outside the root/
    );
  });

  it('deletes without complaining about a missing file', async () => {
    const { key } = await storage.put(Buffer.from('x'), 'png');
    await storage.delete(key);
    // Deleting twice should not throw: cleanup paths run more than once.
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });
});
