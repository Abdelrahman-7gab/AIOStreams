import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertSubtitle } from './subtitles.js';

// An SRT ripped from an ASS script: a sign at the top, styling inline.
const RIPPED_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  '{\\an8}Twenty years later',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,500',
  '{\\i1}Where are you going?{\\i0}',
  '',
  '3',
  '00:00:07,000 --> 00:00:08,000',
  '<i>Home.</i>',
  '',
].join('\n');

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.00,Sign,,0,0,0,,{\\an8\\fs40}Twenty years later',
  'Dialogue: 0,0:00:04.00,0:00:06.50,Default,,0,0,0,,{\\i1}Where are you going?{\\i0}\\NNow?',
  '',
].join('\n');

/** The cue blocks after the header, as [timing line, text lines]. */
function vttCues(vtt: string): [string, string][] {
  return vtt
    .replace(/^WEBVTT\n\n/, '')
    .trim()
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n');
      return [lines[1], lines.slice(2).join('\n')];
    });
}

describe('convertSubtitle to WebVTT', () => {
  it('moves an {\\an8} line to the top instead of printing the tag', () => {
    const [sign] = vttCues(convertSubtitle(RIPPED_SRT, 'srt', 'vtt').body);
    assert.equal(sign[0], '00:00:01.000 --> 00:00:03.000 line:0');
    assert.equal(sign[1], 'Twenty years later');
  });

  it('drops other ASS tags and keeps the HTML-style ones WebVTT reads', () => {
    const vtt = convertSubtitle(RIPPED_SRT, 'srt', 'vtt').body;
    assert.doesNotMatch(vtt, /\{\\/);
    const [, line, home] = vttCues(vtt);
    assert.deepEqual(line, [
      '00:00:04.000 --> 00:00:06.500',
      'Where are you going?',
    ]);
    assert.deepEqual(home, ['00:00:07.000 --> 00:00:08.000', '<i>Home.</i>']);
  });

  it('places the other numpad positions', () => {
    const at = (tag: string) =>
      vttCues(
        convertSubtitle(
          `1\n00:00:01,000 --> 00:00:02,000\n${tag}Hi\n`,
          'srt',
          'vtt'
        ).body
      )[0][0]
        .replace('00:00:01.000 --> 00:00:02.000', '')
        .trim();
    assert.equal(at('{\\an7}'), 'line:0 align:start');
    assert.equal(at('{\\an9}'), 'line:0 align:end');
    assert.equal(at('{\\an5}'), 'line:50%');
    assert.equal(at('{\\an1}'), 'align:start');
    assert.equal(at('{\\an2}'), '');
    assert.equal(at(''), '');
  });

  it('keeps the position of an ASS script converted for the player', () => {
    const [sign, line] = vttCues(convertSubtitle(ASS, 'srt', 'vtt').body);
    assert.deepEqual(sign, [
      '00:00:01.000 --> 00:00:03.000 line:0',
      'Twenty years later',
    ]);
    assert.deepEqual(line, [
      '00:00:04.000 --> 00:00:06.500',
      'Where are you going?\nNow?',
    ]);
  });

  it('leaves braces that are not ASS tags alone in an SRT', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nThe set {a, b}\n';
    assert.equal(
      vttCues(convertSubtitle(srt, 'srt', 'vtt').body)[0][1],
      'The set {a, b}'
    );
  });
});

describe('convertSubtitle to SRT and JSON', () => {
  it('passes an SRT through untouched, since SRT players read {\\an8}', () => {
    assert.equal(convertSubtitle(RIPPED_SRT, 'srt', 'srt').body, RIPPED_SRT);
  });

  it('writes the position of an ASS sign as {\\an8} in SRT', () => {
    const srt = convertSubtitle(ASS, 'ass', 'srt').body;
    assert.match(
      srt,
      /^1\n00:00:01,000 --> 00:00:03,000\n\{\\an8\}Twenty years later\n/
    );
    assert.match(
      srt,
      /\n2\n00:00:04,000 --> 00:00:06,500\nWhere are you going\?\nNow\?\n$/
    );
  });

  it("gives Jellyfin's own renderer text without tags", () => {
    const json = JSON.parse(convertSubtitle(RIPPED_SRT, 'srt', 'json').body);
    assert.deepEqual(
      json.TrackEvents.map((e: { Text: string }) => e.Text),
      ['Twenty years later', 'Where are you going?', '<i>Home.</i>']
    );
  });
});
