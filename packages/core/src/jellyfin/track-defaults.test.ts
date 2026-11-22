import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  trackPreferencesFrom,
  withDefaultAudioLanguages,
} from './track-defaults.js';

describe('withDefaultAudioLanguages', () => {
  it("gives a user who chose no audio language the server's", () => {
    // A user who never opened the audio settings has nothing stored.
    const filled = withDefaultAudioLanguages(null, ['eng']);
    assert.deepEqual(trackPreferencesFrom(filled).audioLanguages, ['eng']);
  });

  it('treats the empty list the app saves with other settings as no choice', () => {
    // Saving a subtitle setting in the app sends the whole configuration back,
    // audio languages included, empty.
    const stored = {
      AudioLanguagePreference: '',
      AudioLanguages: [],
      SubtitleLanguages: ['ara'],
    };
    const filled = withDefaultAudioLanguages(stored, ['eng', 'jpn']);
    assert.deepEqual(filled.AudioLanguages, ['eng', 'jpn']);
    assert.equal(filled.AudioLanguagePreference, 'eng');
    assert.deepEqual(filled.SubtitleLanguages, ['ara']);
  });

  it("keeps a user's own choice", () => {
    const stored = { AudioLanguages: ['hin'], AudioLanguagePreference: 'hin' };
    assert.deepEqual(
      withDefaultAudioLanguages(stored, ['eng']).AudioLanguages,
      ['hin']
    );
    // A client that only knows the single language counts as a choice too.
    assert.equal(
      withDefaultAudioLanguages({ AudioLanguagePreference: 'fre' }, ['eng'])
        .AudioLanguagePreference,
      'fre'
    );
  });

  it('changes nothing when the server sets no default', () => {
    const stored = { AudioLanguages: [] };
    assert.equal(withDefaultAudioLanguages(stored, []), stored);
    assert.deepEqual(
      trackPreferencesFrom(withDefaultAudioLanguages(null, ['']))
        .audioLanguages,
      []
    );
  });
});
