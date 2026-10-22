// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { newQuickRoomDraft, quickRoomChanges, quickRoomDraftDirty, readQuickRoomDrafts } from '../quickRoomDraft';

const values = {
  rentPrice: 3_000_000, area: 24.5, roomType: 'Studio', amenities: ['Máy lạnh'],
  saleNote: 'Giảm tháng đầu', saleBonusNote: 'Nội bộ', description: 'Ban công', images: ['https://example.test/old.jpg'],
};
const perms = { edit: true, images: true };
afterEach(() => sessionStorage.clear());

it('sends only changed fields and distinguishes keeping from explicitly clearing nullable fields', () => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32));
  expect(quickRoomChanges(draft, perms)).toEqual({ patch: {}, errors: {} });
  draft.price = '3200000'; draft.area = ''; draft.saleNote = ''; draft.description = 'Ban công mới';
  expect(quickRoomChanges(draft, perms)).toEqual({
    patch: { rent_price: 3_200_000, area: null, sale_note: null, description: 'Ban công mới' }, errors: {},
  });
  expect(draft.original.images).toEqual(values.images);
});

it.each(['', '-1', '2.5', 'abc3000', '9007199254740992'])('retains invalid price %j as a draft and blocks validation', price => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32)); draft.price = price;
  expect(quickRoomDraftDirty(draft)).toBe(true);
  expect(quickRoomChanges(draft, perms).errors.price).toBeTruthy();
});

it.each(['-1', '1.234', '1000001', 'NaN'])('rejects invalid area %s', area => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32)); draft.area = area;
  expect(quickRoomChanges(draft, perms).errors.area).toBeTruthy();
});

it('normalizes a decimal comma and deduplicates amenities without touching unchanged image URLs', () => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32));
  draft.area = '25,75'; draft.amenities = ' Máy lạnh \nMáy lạnh\nTủ lạnh\n';
  expect(quickRoomChanges(draft, perms)).toEqual({ patch: { area: 25.75, amenities: ['Máy lạnh', 'Tủ lạnh'] }, errors: {} });
});

it('cannot mix room fields into an image-only write after a capability change', () => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32));
  draft.price = '4000000'; draft.saleBonusNote = 'Thưởng mới'; draft.images.push('room-sale-images/actor/new.jpg');
  expect(quickRoomChanges(draft, { edit: false, images: true })).toEqual({ patch: { images: draft.images }, errors: {} });
});

it('an image-only edit by a room editor preserves null legacy price and unchanged unnormalized fields', () => {
  const draft = newQuickRoomDraft({
    ...values, rentPrice: null, roomType: ' Studio ', saleNote: '  Chính sách cũ  ',
    saleBonusNote: ' x '.repeat(1000), description: ' Mô tả cũ ', amenities: [' Máy lạnh ', ' Máy lạnh '],
  }, 'a'.repeat(32));
  draft.images.push('room-sale-images/actor/new.jpg');
  expect(quickRoomChanges(draft, perms)).toEqual({ patch: { images: draft.images }, errors: {} });
});

it('a description-only edit does not create a zero price from an unchanged empty legacy price', () => {
  const draft = newQuickRoomDraft({ ...values, rentPrice: null }, 'a'.repeat(32));
  draft.description = 'Ban công mới';
  expect(quickRoomChanges(draft, perms)).toEqual({ patch: { description: 'Ban công mới' }, errors: {} });
  draft.price = '0';
  expect(quickRoomChanges(draft, perms).patch.rent_price).toBe(0);
});

it('rejects a price beyond the database numeric limit without rounding it', () => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32)); draft.price = '10000000000000';
  expect(quickRoomChanges(draft, perms).errors.price).toBeTruthy();
  draft.price = '9999999999999';
  expect(quickRoomChanges(draft, perms).errors).toEqual({});
});

it.each(['blob:test', 'data:image/png,test', 'http://example.test/a.jpg', 'javascript:alert(1)', '//example.test/a', '../private.jpg', 'https://user:secret@example.test/a'])('rejects an unsafe image reference %s', image => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32)); draft.images.push(image);
  expect(quickRoomChanges(draft, perms).errors.images).toBeTruthy();
});

it('reads only well-shaped scoped drafts and preserves a pending request identity', () => {
  const draft = newQuickRoomDraft(values, 'a'.repeat(32));
  draft.price = '3500000'; draft.request = { id: 'request-one', fingerprint: 'same', patch: { rent_price: 3500000 }, unknown: true };
  sessionStorage.setItem('actor-org', JSON.stringify({ one: draft, broken: { revision: 'x' } }));
  expect(readQuickRoomDrafts('actor-org')).toEqual({ one: draft });
  expect(readQuickRoomDrafts('different-actor')).toEqual({});
  sessionStorage.setItem('actor-org', '{broken');
  expect(readQuickRoomDrafts('actor-org')).toEqual({});
});
