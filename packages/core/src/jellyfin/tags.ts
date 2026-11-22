/**
 * Tags group a configuration's Jellyfin users: `/jellyfin/<tag>` opens a
 * picker of just that tag's users, and a signed-in user with tags sees only
 * the users who share one of them. A user without tags sees everyone.
 */

/** Lowercase, so it reads well in an address and never collides with an API path. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Names `/jellyfin/<tag>` can't take: the mounts beside it and paths clients
 * request in lowercase. API paths are PascalCase, so the pattern keeps them out.
 */
export const RESERVED_TAGS: ReadonlySet<string> = new Set([
  'u',
  'p',
  'web',
  'socket',
  'health',
  'emby',
  'mediabrowser',
  'api',
  'aiostreams',
  'system',
  'users',
  'items',
  'sessions',
  'videos',
  'audio',
  'shows',
  'movies',
  'library',
  'branding',
  'quickconnect',
  'playback',
  'livetv',
  'syncplay',
  'startup',
  'plugins',
  'devices',
  'search',
  'images',
  'playlists',
  'collections',
  'auth',
]);

/** Whether `value` can be a tag. */
export function isValidTag(value: string): boolean {
  return TAG_PATTERN.test(value) && !RESERVED_TAGS.has(value);
}

/** A tag as typed: trimmed, lowercased, spaces to dashes. Empty when nothing usable is left. */
export function normaliseTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, 32);
}

interface Tagged {
  tags?: readonly string[];
}

/** Every tag the configuration's users carry, each once, in first-seen order. */
export function configTags(
  jellyfin:
    | { primary?: Tagged | undefined; personas?: readonly Tagged[] | undefined }
    | undefined
): string[] {
  const seen = new Set<string>();
  for (const user of [jellyfin?.primary, ...(jellyfin?.personas ?? [])])
    for (const tag of user?.tags ?? []) seen.add(tag);
  return [...seen];
}

/** Whether a signed-in user with `callerTags` may see a user with `userTags`. */
export function tagsAllow(
  callerTags: readonly string[] | undefined,
  userTags: readonly string[] | undefined
): boolean {
  if (!callerTags?.length) return true;
  return !!userTags?.some((tag) => callerTags.includes(tag));
}

/** A configuration's users as these rules need them; `null` is the account's own user. */
interface Users<P extends PickerUser> {
  jellyfin?:
    | {
        primary?: { hidden?: boolean; tags?: readonly string[] } | undefined;
        personas?: readonly P[] | undefined;
      }
    | undefined;
}

interface PickerUser {
  id: string;
  hidden?: boolean;
  tags?: readonly string[];
}

/** A user's tags; the account's own live on `primary`. */
export function userTags<P extends PickerUser>(
  config: Users<P>,
  user: P | null
): readonly string[] | undefined {
  return user ? user.tags : config.jellyfin?.primary?.tags;
}

function isHiddenUser<P extends PickerUser>(
  config: Users<P>,
  user: P | null
): boolean {
  return !!(user ? user.hidden : config.jellyfin?.primary?.hidden);
}

/**
 * Whether a signed-in `caller` sees `user` in lists: always itself; never a
 * hidden user, nor anyone when hidden itself; and, when it has tags, only
 * users sharing one of them.
 */
export function userListedFor<P extends PickerUser>(
  config: Users<P>,
  caller: P | null,
  user: P | null
): boolean {
  if ((caller?.id ?? '') === (user?.id ?? '')) return true;
  if (caller?.hidden || isHiddenUser(config, user)) return false;
  return tagsAllow(userTags(config, caller), userTags(config, user));
}

/** What a picker address names: a hidden user's own (`persona`), a tag's (`tag`), or neither. */
export interface PickerScope {
  persona?: string;
  tag?: string;
}

/**
 * The users a picker shows: a personal address its own hidden user, a tag's
 * address the users with that tag, the main one everyone not hidden.
 */
export function pickerUsers<P extends PickerUser>(
  scope: PickerScope,
  config: Users<P>
): (P | null)[] {
  const personas = config.jellyfin?.personas ?? [];
  if (scope.persona)
    return personas.filter((p) => p.id === scope.persona && p.hidden);
  const shown = [null, ...personas].filter((p) => !isHiddenUser(config, p));
  const tag = scope.tag;
  return tag ? shown.filter((p) => userTags(config, p)?.includes(tag)) : shown;
}

/** Whether a picker address may sign in as `user`: a tag's address only its own users. */
export function pickerAllows<P extends PickerUser>(
  scope: PickerScope | undefined,
  config: Users<P>,
  user: P | null
): boolean {
  return !scope?.tag || !!userTags(config, user)?.includes(scope.tag);
}
