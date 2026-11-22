import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The package entry first: loaded alone, the expression engine meets an
// import cycle through the variants module.
import '../index.js';
import { StreamSelector } from './streamExpression.js';
import type { ParsedStream } from '../db/schemas.js';

/** The expression the config excludes streams with. */
const TOO_SHORT =
  "queryType == 'movie' and runtime > 0 ? duration(streams, 1, runtime * 0.85) : []";

class Selector extends StreamSelector {
  stream(id: string, minutes?: number): ParsedStream {
    return this.createTestStream({
      id,
      type: 'debrid',
      duration: minutes === undefined ? undefined : minutes * 60_000,
    });
  }
}

const ids = (streams: ParsedStream[]) => streams.map((s) => s.id).sort();

describe('duration()', () => {
  it("finds a film's files far shorter than the film", async () => {
    // A 172-minute film: an 86-minute file is another film, a 2-minute one a
    // clip; the cut, the extended cut and a file of unknown length stay.
    const selector = new Selector({ queryType: 'movie', runtime: 172 });
    const streams = [
      selector.stream('other-film', 86),
      selector.stream('clip', 2),
      selector.stream('theatrical', 165),
      selector.stream('extended', 200),
      selector.stream('unknown'),
    ];
    assert.deepEqual(ids(await selector.select(streams, TOO_SHORT)), [
      'clip',
      'other-film',
    ]);
  });

  it('drops a cut far shorter than the film but keeps sped-up releases', async () => {
    // Project Hail Mary is listed at 157 minutes. A 123-minute "2160p" file was
    // played first; real releases run 151 to 156 minutes, and a PAL speed-up
    // (4% faster) gives about 151.
    const selector = new Selector({ queryType: 'movie', runtime: 157 });
    const streams = [
      selector.stream('cut', 123),
      selector.stream('pal', 151),
      selector.stream('web-dl', 156),
    ];
    assert.deepEqual(ids(await selector.select(streams, TOO_SHORT)), ['cut']);
  });

  it('removes nothing when the runtime is unknown', async () => {
    const selector = new Selector({ queryType: 'movie', runtime: 0 });
    const streams = [selector.stream('a', 20), selector.stream('b', 120)];
    assert.deepEqual(await selector.select(streams, TOO_SHORT), []);
  });

  it('leaves series episodes alone', async () => {
    const selector = new Selector({ queryType: 'series', runtime: 45 });
    const streams = [selector.stream('short-episode', 22)];
    assert.deepEqual(await selector.select(streams, TOO_SHORT), []);
  });

  it('takes either bound alone', async () => {
    const selector = new Selector({ queryType: 'movie' });
    const streams = [
      selector.stream('short', 30),
      selector.stream('long', 150),
    ];
    assert.deepEqual(
      ids(await selector.select(streams, 'duration(streams, 60)')),
      ['long']
    );
    assert.deepEqual(
      ids(await selector.select(streams, 'duration(streams, 0, 60)')),
      ['short']
    );
  });
});
