import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { madeOnDemand } from './service.js';

describe('madeOnDemand', () => {
  it('flags subtitles made when asked for, which a check would start', () => {
    for (const path of [
      '/addon/cfg/translate/123/ara',
      '/addon/cfg/auto/hash/ara/456',
      '/addon/cfg/learn/123/ara',
      '/addon/cfg/xsync/hash/ara/456',
      '/addon/cfg/xembedded/hash/ara/2',
      '/addon/cfg/file-translate/tt1:1:1',
      '/addon/cfg/sync-subtitles/tt1:1:1',
    ])
      assert.equal(
        madeOnDemand(`https://submaker.example.com${path}`),
        true,
        path
      );
  });

  it('leaves ordinary subtitle files to be checked', () => {
    for (const path of [
      '/addon/cfg/subtitle/abc/ara.srt',
      '/addon/cfg/subtitle-content/abc/eng.vtt',
      '/subtitles/opensubtitles/123.srt',
    ])
      assert.equal(
        madeOnDemand(`https://subs.example.com${path}`),
        false,
        path
      );
  });
});
