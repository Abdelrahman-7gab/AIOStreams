import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decoded } from './file.js';

describe('decoded', () => {
  it('inflates compressed private data of ordinary size', async () => {
    const out = await decoded(
      deflateSync(Buffer.from('[Script Info]\nTitle: x')),
      { algo: 0, scope: 2 },
      2
    );
    assert.equal(Buffer.from(out).toString(), '[Script Info]\nTitle: x');
  });

  it('rejects a zip bomb instead of inflating it', async () => {
    // 64 MB of zeros compresses to about 64 KB.
    const bomb = deflateSync(Buffer.alloc(64 << 20));
    assert.ok(bomb.length < 1 << 20);
    await assert.rejects(decoded(bomb, { algo: 0, scope: 2 }, 2));
  });
});
