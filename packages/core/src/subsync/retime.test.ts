import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPlan, readTimes } from './retime.js';
import type { RetimePlan } from './plan.js';

const plan = (delays: number[], ratio = 1): RetimePlan => ({
  ratio,
  delays,
  parts: [{ fromLine: 0, delayMs: delays[0] }],
});

describe('readTimes and applyPlan', () => {
  it('moves SRT times and keeps everything else', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,500',
      'Hello',
      '',
      '2',
      '00:01:00,250 --> 00:01:03,000',
      '<i>There</i>',
      '',
    ].join('\r\n');
    const timed = readTimes(srt);
    assert.ok(timed);
    assert.equal(timed.format, 'cue');
    assert.deepEqual(timed.spans, [
      { startMs: 1000, endMs: 2500 },
      { startMs: 60250, endMs: 63000 },
    ]);
    const out = applyPlan(timed, plan([1500, -250]));
    assert.equal(
      out,
      [
        '1',
        '00:00:02,500 --> 00:00:04,000',
        'Hello',
        '',
        '2',
        '00:01:00,000 --> 00:01:02,750',
        '<i>There</i>',
        '',
      ].join('\n')
    );
  });

  it('keeps WebVTT settings and its dot separator', () => {
    const vtt = 'WEBVTT\n\n00:05.000 --> 00:06.000 align:start line:90%\nHi\n';
    const timed = readTimes(vtt)!;
    const out = applyPlan(timed, plan([2000]));
    assert.match(
      out,
      /^00:00:07\.000 --> 00:00:08\.000 align:start line:90%$/m
    );
    assert.match(out, /^WEBVTT$/m);
  });

  it('moves ASS dialogue in centiseconds and never below zero', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Hi, there{\\i0}',
    ].join('\n');
    const timed = readTimes(ass)!;
    assert.equal(timed.format, 'ass');
    const out = applyPlan(timed, plan([-1500]));
    assert.match(
      out,
      /^Dialogue: 0,0:00:00\.00,0:00:01\.00,Default,,0,0,0,,\{\\i1\}Hi, there\{\\i0\}$/m
    );
  });

  it('stretches by the ratio before moving', () => {
    const srt = '1\n00:01:40,000 --> 00:01:42,000\nx\n';
    const out = applyPlan(readTimes(srt)!, plan([0], 1.5));
    assert.match(out, /00:02:30,000 --> 00:02:33,000/);
  });

  it('gives back text in any encoding byte for byte', () => {
    // "مرحبا" in UTF-8 and a Windows-1256 byte, read as Latin-1 the way the service does.
    const bytes = Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'),
      Buffer.from('مرحبا', 'utf8'),
      Buffer.from([0xc7, 0x0a]),
    ]);
    const out = applyPlan(readTimes(bytes.toString('latin1'))!, plan([1000]));
    const back = Buffer.from(out, 'latin1');
    assert.deepEqual(
      back.subarray(back.length - 12),
      bytes.subarray(bytes.length - 12)
    );
    assert.match(back.toString('latin1'), /00:00:02,000 --> 00:00:03,000/);
  });

  it('reads nothing from a body without times', () => {
    assert.equal(readTimes('just some text\nno cues here'), null);
  });
});
