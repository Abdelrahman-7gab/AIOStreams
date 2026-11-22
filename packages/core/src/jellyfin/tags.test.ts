import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  configTags,
  isValidTag,
  normaliseTag,
  pickerAllows,
  pickerUsers,
  tagsAllow,
  userListedFor,
} from './tags.js';

describe('isValidTag', () => {
  it('takes short lowercase names for an address', () => {
    for (const tag of ['home', 'friends', 'cousins-2', 'a'])
      assert.equal(isValidTag(tag), true, tag);
  });

  it('refuses what would clash with the Jellyfin paths beside it', () => {
    for (const tag of ['web', 'u', 'p', 'socket', 'health', 'users'])
      assert.equal(isValidTag(tag), false, tag);
  });

  it('refuses capitals, spaces, symbols, a leading dash and long names', () => {
    for (const tag of [
      'Home',
      'my friends',
      'home!',
      '-home',
      '',
      'x'.repeat(33),
      // A configuration id is longer than any tag, so it never looks like one.
      '1dbf5839-3d00-4070-a60b-8d21634b68cd',
    ])
      assert.equal(isValidTag(tag), false, tag);
  });
});

describe('normaliseTag', () => {
  it('turns what someone types into a tag', () => {
    assert.equal(normaliseTag('  Best Friends '), 'best-friends');
    assert.equal(normaliseTag('Home!'), 'home');
    assert.equal(normaliseTag('--x'), 'x');
    assert.equal(normaliseTag('!!!'), '');
  });
});

describe('tagsAllow', () => {
  it('lets someone without tags see everyone', () => {
    assert.equal(tagsAllow(undefined, ['friends']), true);
    assert.equal(tagsAllow([], undefined), true);
  });

  it('shows a tagged user only the people sharing a tag', () => {
    assert.equal(tagsAllow(['friends'], ['friends', 'home']), true);
    assert.equal(tagsAllow(['friends'], ['home']), false);
    // An untagged user is outside every group.
    assert.equal(tagsAllow(['friends'], undefined), false);
    assert.equal(tagsAllow(['home', 'friends'], ['friends']), true);
  });
});

describe('configTags', () => {
  it("lists every user's tags once, the primary user's included", () => {
    assert.deepEqual(
      configTags({
        primary: { tags: ['home'] },
        personas: [{ tags: ['home', 'friends'] }, {}, { tags: ['friends'] }],
      }),
      ['home', 'friends']
    );
    assert.deepEqual(configTags(undefined), []);
  });
});

// The owner untagged; two households and someone in both.
const user = (
  id: string,
  extra: { tags?: string[]; hidden?: boolean } = {}
) => ({ id, ...extra });
const omar = user('omar', { tags: ['friends'] });
const salma = user('salma', { tags: ['friends'] });
const shahd = user('shahd', { tags: ['home'] });
const sara = user('sara', { tags: ['home', 'friends'] });
const vivian = user('vivian'); // no tags
const hidden = user('hidden', { tags: ['friends'], hidden: true });
const config = {
  jellyfin: {
    primary: {},
    personas: [omar, salma, shahd, sara, vivian, hidden],
  },
};
type User = ReturnType<typeof user>;
const ids = (users: (User | null)[]) => users.map((u) => u?.id ?? 'owner');

describe('pickerUsers', () => {
  it("lists only a tag's users at its address, not hidden ones", () => {
    assert.deepEqual(ids(pickerUsers({ tag: 'friends' }, config)), [
      'omar',
      'salma',
      'sara',
    ]);
    assert.deepEqual(ids(pickerUsers({ tag: 'home' }, config)), [
      'shahd',
      'sara',
    ]);
    assert.deepEqual(ids(pickerUsers({ tag: 'cousins' }, config)), []);
  });

  it('lists the owner when the owner has the tag', () => {
    const tagged = {
      jellyfin: { ...config.jellyfin, primary: { tags: ['home'] } },
    };
    assert.deepEqual(ids(pickerUsers({ tag: 'home' }, tagged)), [
      'owner',
      'shahd',
      'sara',
    ]);
  });

  it('leaves the main picker showing everyone not hidden', () => {
    assert.deepEqual(ids(pickerUsers({}, config)), [
      'owner',
      'omar',
      'salma',
      'shahd',
      'sara',
      'vivian',
    ]);
  });

  it("shows a hidden user's own address only that user", () => {
    assert.deepEqual(ids(pickerUsers({ persona: 'hidden' }, config)), [
      'hidden',
    ]);
  });
});

describe('pickerAllows', () => {
  it("lets a tag's address sign in only that tag's users", () => {
    assert.equal(pickerAllows({ tag: 'friends' }, config, omar), true);
    assert.equal(pickerAllows({ tag: 'friends' }, config, shahd), false);
    assert.equal(pickerAllows({ tag: 'friends' }, config, null), false);
  });

  it('leaves other addresses as they were', () => {
    assert.equal(pickerAllows(undefined, config, shahd), true);
    assert.equal(pickerAllows({}, config, null), true);
  });
});

describe('userListedFor', () => {
  const seenBy = (caller: User | null) =>
    ids(
      [null, ...config.jellyfin.personas].filter((u) =>
        userListedFor(config, caller, u)
      )
    );

  it('shows a tagged user only themself and their tag-mates', () => {
    assert.deepEqual(seenBy(omar), ['omar', 'salma', 'sara']);
    assert.deepEqual(seenBy(shahd), ['shahd', 'sara']);
    // In both groups, so sees both.
    assert.deepEqual(seenBy(sara), ['omar', 'salma', 'shahd', 'sara']);
  });

  it('shows an untagged user everyone not hidden, as before tags', () => {
    assert.deepEqual(seenBy(null), [
      'owner',
      'omar',
      'salma',
      'shahd',
      'sara',
      'vivian',
    ]);
    assert.deepEqual(seenBy(vivian), seenBy(null));
  });

  it('keeps a hidden user apart even from their tag-mates', () => {
    assert.deepEqual(seenBy(hidden), ['hidden']);
    assert.equal(seenBy(omar).includes('hidden'), false);
  });
});
