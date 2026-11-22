import { tagLanguage } from '../utils/languages.js';
import type { JellyfinMediaStream } from './types.js';

export const SUBTITLE_MODES = [
  'Default',
  'Always',
  'OnlyForced',
  'None',
  'Smart',
] as const;
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];

/** The kinds of subtitle track a user ranks; commentary always comes last. */
export const SUBTITLE_TYPES = ['normal', 'sdh', 'forced', 'signs'] as const;
export type SubtitleType = (typeof SUBTITLE_TYPES)[number];

/** The kinds of audio track a user ranks. */
export const AUDIO_TYPES = ['main', 'description', 'commentary'] as const;
export type AudioType = (typeof AUDIO_TYPES)[number];

export interface TrackPreferences {
  /** Language codes in order, any of them `OriginalLanguage`. */
  audioLanguages: string[];
  playDefaultAudioTrack: boolean;
  audioTypes: AudioType[];
  subtitleLanguages: string[];
  subtitleMode: SubtitleMode;
  subtitleTypes: SubtitleType[];
}

/** The stored order of `all`, any it leaves out after the rest. */
function ranked<T extends string>(stored: unknown, all: readonly T[]): T[] {
  const order = Array.isArray(stored) ? stored : [];
  const saved = all
    .filter((t) => order.includes(t))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...new Set([...saved, ...all])];
}

/** The user picked audio languages of their own, as a list or Jellyfin's single one. */
function hasOwnLanguages(config: Record<string, unknown> | null | undefined) {
  const list = config?.AudioLanguages;
  const single = config?.AudioLanguagePreference;
  return (
    (Array.isArray(list) && list.some((l) => typeof l === 'string' && !!l)) ||
    (typeof single === 'string' && !!single)
  );
}

/**
 * A user's configuration with the server's audio languages when the user has
 * chosen none, so a file's own default track is only the last resort.
 *
 * `playDefaultTrack` is the server's "play the version's default track first".
 * It only means something next to languages, so a user on the server's
 * languages takes it whatever their configuration holds (the app saves the
 * switch along with any other setting); a user with their own languages keeps
 * their own switch, and takes the server's only when they never set one.
 */
export function withDefaultAudioLanguages(
  config: Record<string, unknown> | null | undefined,
  defaults: readonly string[],
  playDefaultTrack = true
): Record<string, unknown> {
  const own = config ?? {};
  const languages = defaults.filter((l) => l);
  if (!hasOwnLanguages(own) && languages.length)
    return {
      ...own,
      AudioLanguagePreference: languages[0],
      AudioLanguages: [...languages],
      PlayDefaultAudioTrack: playDefaultTrack,
    };
  if (!playDefaultTrack && typeof own.PlayDefaultAudioTrack !== 'boolean')
    return { ...own, PlayDefaultAudioTrack: false };
  return own;
}

const LANGUAGE_LISTS = [
  ['AudioLanguagePreference', 'AudioLanguages'],
  ['SubtitleLanguagePreference', 'SubtitleLanguages'],
] as const;

/**
 * Keeps each single language the first of its list. A client that only knows
 * the single one may send back the list it read, so a single language that
 * isn't that list's first is its choice, and goes to the front.
 */
function withLanguageLists(
  config: Record<string, unknown>,
  sent: Record<string, unknown>
): Record<string, unknown> {
  for (const [single, list] of LANGUAGE_LISTS) {
    if (!(single in sent) && !(list in sent)) continue;
    const languages = (config[list] as string[] | undefined) ?? [];
    const one = config[single] as string;
    if (single in sent && one !== (languages[0] ?? ''))
      config[list] = one ? [one, ...languages.filter((l) => l !== one)] : [];
    config[single] = (config[list] as string[] | undefined)?.[0] ?? '';
  }
  return config;
}

/**
 * The configuration to store when an app saves `sent` over `stored`, without
 * the audio settings that only repeat what `withDefaultAudioLanguages` filled
 * in. The apps read a configuration and save the whole of it back, so without
 * this the server's default would become each user's own choice the first time
 * they saved any setting, and a later change of the default would never reach
 * them. What differs from what the app read, in the languages or in the
 * switch, is their choice and is kept whole. A user who picks exactly the
 * default languages follows them from then.
 *
 * A stock Jellyfin app knows only the single language, so a user on the
 * server's languages sends back just their first: that is the whole default.
 * The switch the app read was the server's unless the user has their own
 * languages and their own switch stored, and saved back unchanged it stays the
 * server's.
 */
export function withoutDefaultAudioLanguages(
  sent: Record<string, unknown>,
  defaults: readonly string[],
  playDefaultTrack = true,
  stored: Record<string, unknown> | null = null
): Record<string, unknown> {
  const languages = defaults.filter((l) => l);
  const onDefault = !!languages.length && !hasOwnLanguages(stored);
  const sentList = sent.AudioLanguages;
  const echoed =
    onDefault &&
    !(Array.isArray(sentList) && sentList.length) &&
    sent.AudioLanguagePreference === languages[0];
  const incoming = echoed ? { ...sent, AudioLanguages: [...languages] } : sent;
  const config = withLanguageLists({ ...stored, ...incoming }, incoming);

  const list = config.AudioLanguages;
  const single = config.AudioLanguagePreference;
  const noLanguages =
    (list === undefined || (Array.isArray(list) && !list.length)) &&
    (single === undefined || single === '');
  const languagesAreDefault =
    !!languages.length &&
    Array.isArray(list) &&
    list.length === languages.length &&
    list.every((l, i) => l === languages[i]) &&
    (single === undefined || single === languages[0]);
  const play = config.PlayDefaultAudioTrack;
  const rest = { ...config };
  // On the server's languages the server's switch applies, so a switch of
  // their own needs the languages kept with it.
  if (languagesAreDefault || (noLanguages && languages.length)) {
    if (play !== undefined && play !== playDefaultTrack) return config;
    if (languagesAreDefault) {
      delete rest.AudioLanguages;
      delete rest.AudioLanguagePreference;
    }
    delete rest.PlayDefaultAudioTrack;
    return rest;
  }
  const ownSwitch =
    !onDefault && typeof stored?.PlayDefaultAudioTrack === 'boolean';
  if (play === playDefaultTrack && !ownSwitch)
    delete rest.PlayDefaultAudioTrack;
  return rest;
}

/**
 * A user's track preferences for one title. With `originalOnlyForAnime`,
 * "Original language" counts only for anime: elsewhere it is passed over, so
 * the next language (English, say) plays rather than a film's own language.
 */
export function audioPreferencesForTitle(
  prefs: TrackPreferences,
  isAnime: boolean | undefined,
  originalOnlyForAnime: boolean
): TrackPreferences {
  if (!originalOnlyForAnime || isAnime) return prefs;
  const audioLanguages = prefs.audioLanguages.filter((l) => !isOriginal(l));
  return audioLanguages.length === prefs.audioLanguages.length
    ? prefs
    : { ...prefs, audioLanguages };
}

/** A stored configuration, with Jellyfin's defaults for what it leaves out. */
export function trackPreferencesFrom(
  config: Record<string, unknown> | null | undefined
): TrackPreferences {
  // The ordered list where there is one, else Jellyfin's single language.
  const languages = (list: string, single: string) => {
    const value = config?.[list];
    if (Array.isArray(value) && value.length)
      return value.filter((v): v is string => typeof v === 'string' && !!v);
    const one = config?.[single];
    return typeof one === 'string' && one ? [one] : [];
  };
  const mode = SUBTITLE_MODES.find((m) => m === config?.SubtitleMode);
  return {
    audioLanguages: languages('AudioLanguages', 'AudioLanguagePreference'),
    playDefaultAudioTrack: config?.PlayDefaultAudioTrack !== false,
    audioTypes: ranked(config?.AudioTypes, AUDIO_TYPES),
    subtitleLanguages: languages(
      'SubtitleLanguages',
      'SubtitleLanguagePreference'
    ),
    subtitleMode: mode ?? 'Default',
    subtitleTypes: ranked(config?.SubtitleTypes, SUBTITLE_TYPES),
  };
}

/** The language a code or tag names; one the mapping lacks stays as written. */
function canonical(code: unknown): string | undefined {
  if (typeof code !== 'string') return undefined;
  const lower = code.trim().toLowerCase();
  if (!lower) return undefined;
  return tagLanguage(lower) ?? lower;
}

const isOriginal = (language: string | undefined) =>
  language?.toLowerCase() === 'originallanguage';

const known = (codes: (string | undefined)[]) => [
  ...new Set(codes.filter((c): c is string => !!c)),
];

const UNDEFINED_LANGUAGES = new Set([
  'und',
  'unknown',
  'undetermined',
  'mul',
  'zxx',
]);

function undefinedLanguage(stream: JellyfinMediaStream): boolean {
  const language = canonical(stream.Language);
  return !language || UNDEFINED_LANGUAGES.has(language);
}

/** No preferred language matches any. */
function matches(stream: JellyfinMediaStream, preferred: string[]): boolean {
  return !preferred.length || preferred.includes(canonical(stream.Language)!);
}

const flag = (stream: JellyfinMediaStream, key: string) => stream[key] === true;

const COMMENTARY = /\bcommentary\b/;
const DESCRIPTION = /\b(audio description|descriptive audio|described video)\b/;
const SIGNS = /\b(signs?|songs?)\b/;
const FORCED = /\bforced\b/;
const SDH = /\b(sdh|cc|hearing[ -]impaired)\b/;

/** Signs before forced, as files often flag a signs and songs track forced. */
function subtitleType(
  stream: JellyfinMediaStream
): SubtitleType | 'commentary' {
  const title =
    typeof stream.Title === 'string' ? stream.Title.toLowerCase() : '';
  if (COMMENTARY.test(title)) return 'commentary';
  if (SIGNS.test(title)) return 'signs';
  if (flag(stream, 'IsForced') || FORCED.test(title)) return 'forced';
  if (flag(stream, 'IsHearingImpaired') || SDH.test(title)) return 'sdh';
  return 'normal';
}

/** Only forced lines, which a signs and songs track also is. */
const forcedOnly = (stream: JellyfinMediaStream) =>
  ['forced', 'signs'].includes(subtitleType(stream));

/** Stable, so equal keys keep the file's order. */
function sortBy(
  streams: JellyfinMediaStream[],
  ...keys: ((stream: JellyfinMediaStream) => number | boolean)[]
): JellyfinMediaStream[] {
  return [...streams].sort((a, b) => {
    for (const key of keys) {
      const diff = Number(key(b)) - Number(key(a));
      if (diff) return diff;
    }
    return 0;
  });
}

function score(stream: JellyfinMediaStream, preferred: string[]): number {
  const at = preferred.indexOf(canonical(stream.Language) ?? '');
  let total = at === -1 ? 1 : 101 - at;
  for (const key of [
    'IsForced',
    'IsDefault',
    'SupportsExternalStream',
    'IsTextSubtitleStream',
    'IsExternal',
  ])
    total = total * 10 + (flag(stream, key) ? 2 : 1);
  return total;
}

function audioType(stream: JellyfinMediaStream): AudioType {
  const title = [stream.Title, stream.DisplayTitle]
    .filter((t) => typeof t === 'string')
    .join(' ')
    .toLowerCase();
  if (DESCRIPTION.test(title)) return 'description';
  if (COMMENTARY.test(title)) return 'commentary';
  return 'main';
}

/**
 * The language as before, from kinds the user ranks no lower than main where
 * the version has any, then the best-ranked kind in that language.
 */
function audioIndex(
  streams: JellyfinMediaStream[],
  preferred: string[],
  preferDefault: boolean,
  types: AudioType[]
): number | undefined {
  const rank = (s: JellyfinMediaStream) => types.indexOf(audioType(s));
  const usual = streams.filter((s) => rank(s) <= types.indexOf('main'));
  const sorted = sortBy(usual.length ? usual : streams, (s) =>
    score(s, preferred)
  );
  const chosen =
    (preferDefault ? sorted.find((s) => flag(s, 'IsDefault')) : undefined) ??
    sorted[0];
  if (!chosen) return undefined;
  const language = canonical(chosen.Language);
  return sortBy(
    streams.filter((s) => canonical(s.Language) === language),
    (s) => -rank(s),
    (s) => score(s, preferred)
  )[0].Index;
}

function defaultAudio(
  streams: JellyfinMediaStream[],
  prefs: TrackPreferences,
  originalLanguage: string | undefined
): number | undefined {
  const audio = streams.filter((s) => s.Type === 'Audio');
  const original = canonical(originalLanguage);
  if (isOriginal(prefs.audioLanguages[0]) && !prefs.playDefaultAudioTrack) {
    const flagged = audio.find((s) => flag(s, 'IsOriginal'));
    if (flagged && (!original || canonical(flagged.Language) === original))
      return flagged.Index;
  }
  const preferred = known(
    prefs.audioLanguages.map((l) => (isOriginal(l) ? original : canonical(l)))
  );
  return audioIndex(
    audio,
    preferred,
    prefs.playDefaultAudioTrack,
    prefs.audioTypes
  );
}

function onlyForced(
  sorted: JellyfinMediaStream[],
  preferred: string[]
): JellyfinMediaStream | undefined {
  return sortBy(
    sorted.filter(
      (s) => forcedOnly(s) && (matches(s, preferred) || undefinedLanguage(s))
    ),
    (s) => matches(s, preferred),
    undefinedLanguage
  )[0];
}

/**
 * Jellyfin's subtitle modes, except that the file's own tracks come before
 * external ones and Default mode never turns an external one on: those come
 * from subtitle addons in every language, not files placed beside the video.
 * The user's subtitle types rank tracks before the file's default does.
 */
function subtitleIn(
  streams: JellyfinMediaStream[],
  prefs: TrackPreferences,
  preferred: string[],
  listed: string[],
  audioLanguage: string | undefined
): number {
  const order = prefs.subtitleTypes;
  const sorted = sortBy(
    streams.filter((s) => s.Type === 'Subtitle'),
    (s) => !flag(s, 'IsExternal'),
    (s) => {
      const type = subtitleType(s);
      return type === 'commentary' ? 0 : order.length - order.indexOf(type);
    },
    (s) => flag(s, 'IsDefault')
  );
  let stream: JellyfinMediaStream | undefined;
  switch (prefs.subtitleMode) {
    case 'Default':
      stream = sorted.find(
        (s) =>
          !flag(s, 'IsExternal') &&
          (flag(s, 'IsDefault') || flag(s, 'IsForced'))
      );
      break;
    // Audio in any of the user's languages needs no more than forced lines.
    case 'Smart':
      stream = listed.includes(canonical(audioLanguage) ?? '')
        ? onlyForced(sorted, preferred)
        : sorted.find((s) => matches(s, preferred));
      break;
    case 'Always':
      stream =
        sorted.find((s) => matches(s, preferred)) ??
        onlyForced(sorted, preferred);
      break;
    case 'OnlyForced':
      stream = onlyForced(sorted, preferred);
      break;
  }
  return stream?.Index ?? -1;
}

/** Each language in turn, as the one Jellyfin knows, until one finds a track. */
function defaultSubtitle(
  streams: JellyfinMediaStream[],
  prefs: TrackPreferences,
  audioLanguage: string | undefined
): number {
  if (prefs.subtitleMode === 'None') return -1;
  const languages = known(prefs.subtitleLanguages.map(canonical));
  for (const language of languages.length ? languages : [undefined]) {
    const index = subtitleIn(
      streams,
      prefs,
      language ? [language] : [],
      languages,
      audioLanguage
    );
    if (index !== -1) return index;
  }
  return -1;
}

/**
 * The audio and subtitle tracks a version starts with, as Jellyfin picks them
 * for a user; -1 starts without subtitles.
 */
export function defaultTrackIndexes(
  streams: JellyfinMediaStream[],
  prefs: TrackPreferences,
  originalLanguage?: string
): { audio: number | undefined; subtitle: number } {
  const audio = defaultAudio(streams, prefs, originalLanguage);
  const audioLanguage = streams.find((s) => s.Index === audio)?.Language;
  return {
    audio,
    subtitle: defaultSubtitle(
      streams,
      prefs,
      typeof audioLanguage === 'string' ? audioLanguage : undefined
    ),
  };
}
