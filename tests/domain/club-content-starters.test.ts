import test from 'node:test';
import assert from 'node:assert/strict';
import { starterClubContent } from '../../shared/club-content-starters';
import { validateClubContent } from '../../shared/club-content';
import type { ClubContentSection } from '../../shared/club-content-types';

test('editable starter copy validates for all seven sections without inventing identities, contacts or redeemable inventory', () => {
  for (const section of ['handbook', 'points', 'core', 'contacts', 'business', 'redemption', 'partners'] as ClubContentSection[]) {
    const draft = starterClubContent(section);
    assert.deepEqual(validateClubContent(draft, section), draft);
    assert.deepEqual(draft.people, []); assert.deepEqual(draft.contacts, []); assert.deepEqual(draft.offers, []);
    assert(draft.blocks.length > 0); assert(!/演示|内测|人工智能|AI生成/.test(JSON.stringify(draft)));
    draft.blocks[0].body = '管理员正在修订';
    assert.notEqual(starterClubContent(section).blocks[0].body, '管理员正在修订');
  }
});
