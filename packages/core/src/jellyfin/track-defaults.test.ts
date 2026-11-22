import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  audioPreferencesForTitle,
  defaultTrackIndexes,
  trackPreferencesFrom,
  withDefaultAudioLanguages,
  withoutDefaultAudioLanguages,
} from './track-defaults.js';
import type { JellyfinMediaStream } from './types.js';

describe('audioPreferencesForTitle', () => {
  const audio = (
    Index: number,
    Language: string,
    IsDefault = false
  ): JellyfinMediaStream => ({ Index, Type: 'Audio', Language, IsDefault });
  // "Original language, then English", the default track switch off.
  const prefs = trackPreferencesFrom({
    AudioLanguages: ['OriginalLanguage', 'eng'],
    PlayDefaultAudioTrack: false,
  });
  const pick = (
    streams: JellyfinMediaStream[],
    original: string,
    isAnime: boolean,
    onlyForAnime: boolean
  ) =>
    defaultTrackIndexes(
      streams,
      audioPreferencesForTitle(prefs, isAnime, onlyForAnime),
      original
    ).audio;

  it('plays the Japanese track of an anime episode that also has English', () => {
    const episode = [audio(1, 'eng', true), audio(2, 'jpn')];
    assert.equal(pick(episode, 'ja', true, true), 2);
  });

  it('plays English, not the original, for anything that is not anime', () => {
    // A Hindi film's dual audio release, Hindi marked default.
    const film = [audio(1, 'hin', true), audio(2, 'eng')];
    assert.equal(pick(film, 'hi', false, true), 2);
    // A file flagged as the original language is passed over too.
    const flagged = [
      { ...audio(1, 'hin', true), IsOriginal: true },
      audio(2, 'eng'),
    ];
    assert.equal(pick(flagged, 'hi', false, true), 2);
  });

  it('plays an English dub of an anime that has no Japanese track', () => {
    const dub = [audio(1, 'eng', true), audio(2, 'spa')];
    assert.equal(pick(dub, 'ja', true, true), 1);
  });

  it('leaves the original language to everything when the setting is off', () => {
    const film = [audio(1, 'hin', true), audio(2, 'eng')];
    assert.equal(pick(film, 'hi', false, false), 1);
    assert.equal(audioPreferencesForTitle(prefs, false, false), prefs);
  });
});

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

  it("lets the server's languages win over a file's default track when it says so", () => {
    // The switch only means something next to languages, so a user on the
    // server's languages takes the server's switch, even the true the app
    // saves along with any other setting.
    for (const stored of [
      null,
      { AudioLanguages: [], PlayDefaultAudioTrack: true },
    ]) {
      const prefs = trackPreferencesFrom(
        withDefaultAudioLanguages(stored, ['eng'], false)
      );
      assert.deepEqual(prefs.audioLanguages, ['eng']);
      assert.equal(prefs.playDefaultAudioTrack, false);
    }
  });

  it('keeps the switch of a user who chose their own languages, and fills it when they never set one', () => {
    const own = { AudioLanguages: ['hin'], PlayDefaultAudioTrack: true };
    assert.equal(
      trackPreferencesFrom(withDefaultAudioLanguages(own, ['eng'], false))
        .playDefaultAudioTrack,
      true
    );
    const unset = { AudioLanguages: ['hin'] };
    assert.equal(
      trackPreferencesFrom(withDefaultAudioLanguages(unset, ['eng'], false))
        .playDefaultAudioTrack,
      false
    );
  });

  it('changes nothing when the server sets no default', () => {
    const stored = { AudioLanguages: [] };
    assert.equal(withDefaultAudioLanguages(stored, []), stored);
    assert.equal(withDefaultAudioLanguages(stored, [], true), stored);
    assert.deepEqual(
      trackPreferencesFrom(withDefaultAudioLanguages(null, ['']))
        .audioLanguages,
      []
    );
  });
});

describe('withoutDefaultAudioLanguages', () => {
  // What an app does: read the configuration, then save the whole of it.
  const roundTrip = (
    stored: Record<string, unknown> | null,
    defaults: string[],
    play = true
  ) =>
    withoutDefaultAudioLanguages(
      withDefaultAudioLanguages(stored, defaults, play),
      defaults,
      play,
      stored
    );

  it('leaves a user following the default after the app saves what it read', () => {
    const saved = roundTrip({ SubtitleLanguages: ['ara'] }, ['eng']);
    assert.deepEqual(saved.SubtitleLanguages, ['ara']);
    // The owner later changes the default: the user gets the new one.
    assert.deepEqual(
      trackPreferencesFrom(withDefaultAudioLanguages(saved, ['eng', 'jpn']))
        .audioLanguages,
      ['eng', 'jpn']
    );
    // And the switch back to true, then to false.
    assert.equal(
      trackPreferencesFrom(withDefaultAudioLanguages(saved, ['eng'], false))
        .playDefaultAudioTrack,
      false
    );
    // And an empty default leaves them with none.
    assert.deepEqual(
      trackPreferencesFrom(withDefaultAudioLanguages(saved, [])).audioLanguages,
      []
    );
  });

  it('follows the default when it was never changed from the false the server filled in', () => {
    const saved = roundTrip({ AudioLanguages: [] }, ['eng'], false);
    assert.equal(
      trackPreferencesFrom(withDefaultAudioLanguages(saved, ['eng'], true))
        .playDefaultAudioTrack,
      true
    );
  });

  it('keeps languages the user picked, and their switch', () => {
    const picked = {
      AudioLanguagePreference: 'hin',
      AudioLanguages: ['hin', 'eng'],
      PlayDefaultAudioTrack: false,
    };
    assert.deepEqual(
      withoutDefaultAudioLanguages(picked, ['eng'], true),
      picked
    );
    // Only the order differs from the default: still their choice.
    const reordered = {
      AudioLanguagePreference: 'jpn',
      AudioLanguages: ['jpn', 'eng'],
    };
    assert.deepEqual(
      withoutDefaultAudioLanguages(
        { ...reordered, PlayDefaultAudioTrack: true },
        ['eng', 'jpn']
      ).AudioLanguages,
      ['jpn', 'eng']
    );
  });

  it('keeps the default languages when the user changed the switch with them', () => {
    const own = {
      AudioLanguagePreference: 'eng',
      AudioLanguages: ['eng'],
      PlayDefaultAudioTrack: false,
    };
    assert.deepEqual(withoutDefaultAudioLanguages(own, ['eng'], true), own);
  });

  it('changes nothing when the server sets no languages', () => {
    const stored = {
      AudioLanguagePreference: '',
      AudioLanguages: [],
      PlayDefaultAudioTrack: true,
      SubtitleMode: 'Always',
    };
    // Saved back as it was stored: the switch is the user's own.
    assert.deepEqual(
      withoutDefaultAudioLanguages(stored, [], true, stored),
      stored
    );
    const own = { AudioLanguagePreference: 'hin', AudioLanguages: ['hin'] };
    assert.deepEqual(withoutDefaultAudioLanguages(own, [], true, own), own);
  });

  it('does not change what it is given', () => {
    const filled = withDefaultAudioLanguages(null, ['eng']);
    const copy = structuredClone(filled);
    const stored = { AudioLanguages: [] as string[], SubtitleMode: 'Always' };
    const storedCopy = structuredClone(stored);
    withoutDefaultAudioLanguages(filled, ['eng'], true, stored);
    assert.deepEqual(filled, copy);
    assert.deepEqual(stored, storedCopy);
  });
});

describe('a Jellyfin app reading the configuration, then saving it', () => {
  // GET /Users/Me: Jellyfin's empty audio settings, under what the server fills in.
  const read = (
    stored: Record<string, unknown> | null,
    defaults: string[],
    play: boolean
  ) => ({
    AudioLanguagePreference: '',
    AudioLanguages: [] as string[],
    PlayDefaultAudioTrack: true,
    ...withDefaultAudioLanguages(stored, defaults, play),
  });
  // A stock Jellyfin app knows only the single language, so it never posts the list.
  const stock = (config: Record<string, unknown>) => {
    const { AudioLanguages: _list, ...known } = config;
    return known;
  };
  // POST /Users/Configuration: what is stored after the app saved `sent`.
  const save = (
    sent: Record<string, unknown>,
    stored: Record<string, unknown> | null,
    defaults: string[],
    play: boolean
  ) => withoutDefaultAudioLanguages(sent, defaults, play, stored);
  const prefsAfter = (
    stored: Record<string, unknown>,
    defaults: string[],
    play: boolean
  ) => trackPreferencesFrom(read(stored, defaults, play));

  describe('a stock app on a default of several languages', () => {
    const defaults = ['eng', 'jpn'];

    it('saves back the first language and the user keeps following the whole default', () => {
      const sent = stock(read(null, defaults, true));
      assert.equal(sent.AudioLanguagePreference, 'eng');
      const saved = save(sent, null, defaults, true);
      assert.deepEqual(prefsAfter(saved, defaults, true).audioLanguages, [
        'eng',
        'jpn',
      ]);
      // The owner changes the default: it reaches this user.
      assert.deepEqual(prefsAfter(saved, ['fra', 'eng'], true).audioLanguages, [
        'fra',
        'eng',
      ]);
    });

    it('keeps a different single language the user picked', () => {
      const sent = {
        ...stock(read(null, defaults, true)),
        AudioLanguagePreference: 'fra',
      };
      const saved = save(sent, null, defaults, true);
      assert.deepEqual(prefsAfter(saved, ['deu'], true).audioLanguages, [
        'fra',
      ]);
    });

    it('keeps the whole default, not only its first, when the user turns the switch off', () => {
      const sent = {
        ...stock(read(null, defaults, true)),
        PlayDefaultAudioTrack: false,
      };
      const saved = save(sent, null, defaults, true);
      const prefs = prefsAfter(saved, ['deu'], true);
      assert.deepEqual(prefs.audioLanguages, ['eng', 'jpn']);
      assert.equal(prefs.playDefaultAudioTrack, false);
    });

    it("keeps the user's own list when the app sends back its first language", () => {
      const stored = {
        AudioLanguagePreference: 'eng',
        AudioLanguages: ['eng', 'fra'],
      };
      const saved = save(
        stock(read(stored, defaults, true)),
        stored,
        defaults,
        true
      );
      assert.deepEqual(prefsAfter(saved, ['deu'], true).audioLanguages, [
        'eng',
        'fra',
      ]);
    });
  });

  describe('a user with their own languages who never set the switch', () => {
    const stored = { AudioLanguagePreference: 'fra', AudioLanguages: ['fra'] };

    it('follows the switch when the owner turns it on', () => {
      const saved = save(read(stored, ['eng'], false), stored, ['eng'], false);
      const prefs = prefsAfter(saved, ['eng'], true);
      assert.deepEqual(prefs.audioLanguages, ['fra']);
      assert.equal(prefs.playDefaultAudioTrack, true);
    });

    it('follows the switch when the owner turns it off', () => {
      const saved = save(read(stored, ['eng'], true), stored, ['eng'], true);
      assert.equal(
        prefsAfter(saved, ['eng'], false).playDefaultAudioTrack,
        false
      );
    });

    it('keeps a switch the user set themselves', () => {
      const own = { ...stored, PlayDefaultAudioTrack: false };
      const saved = save(read(own, ['eng'], false), own, ['eng'], false);
      assert.equal(
        prefsAfter(saved, ['eng'], true).playDefaultAudioTrack,
        false
      );
      // And one they change now, to what the server does not do.
      const changed = save(
        { ...read(stored, ['eng'], false), PlayDefaultAudioTrack: true },
        stored,
        ['eng'],
        false
      );
      assert.equal(
        prefsAfter(changed, ['eng'], false).playDefaultAudioTrack,
        true
      );
    });
  });

  it('puts a single subtitle language the app sends at the front of the stored list', () => {
    const stored = {
      SubtitleLanguagePreference: 'eng',
      SubtitleLanguages: ['eng', 'ara'],
    };
    const saved = save(
      { SubtitleLanguagePreference: 'ara' },
      stored,
      ['eng'],
      true
    );
    assert.deepEqual(saved.SubtitleLanguages, ['ara', 'eng']);
    assert.equal(saved.SubtitleLanguagePreference, 'ara');
  });

  describe('a server with no default languages', () => {
    const stored = { SubtitleMode: 'Always' };

    it('lets a switch the app read back follow the owner', () => {
      for (const play of [true, false]) {
        const saved = save(read(stored, [], play), stored, [], play);
        assert.equal(saved.SubtitleMode, 'Always');
        assert.equal(prefsAfter(saved, [], !play).playDefaultAudioTrack, !play);
      }
    });

    it('keeps a switch the user set themselves', () => {
      for (const play of [true, false]) {
        const own = { ...stored, PlayDefaultAudioTrack: play };
        const saved = save(read(own, [], play), own, [], play);
        assert.equal(prefsAfter(saved, [], !play).playDefaultAudioTrack, play);
      }
    });
  });
});
