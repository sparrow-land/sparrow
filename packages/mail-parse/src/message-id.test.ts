import { describe, expect, it } from 'vitest';
import { normalizeMessageId, parseMessageIdList } from './message-id.js';

describe('normalizeMessageId', () => {
  it('passes a well-formed id through untouched', () => {
    expect(normalizeMessageId('<CAF7abc@mail.example.net>')).toBe('<CAF7abc@mail.example.net>');
  });

  it('adds the angle brackets a sloppy sender omitted', () => {
    expect(normalizeMessageId('CAF7abc@mail.example.net')).toBe('<CAF7abc@mail.example.net>');
  });

  it('strips surrounding whitespace and folding', () => {
    expect(normalizeMessageId('  \r\n\t<CAF7abc@mail.example.net>  ')).toBe(
      '<CAF7abc@mail.example.net>',
    );
  });

  it('drops whitespace folded INTO the id', () => {
    expect(normalizeMessageId('<CAF7abc@mail.\r\n example.net>')).toBe(
      '<CAF7abc@mail.example.net>',
    );
  });

  it('preserves case — RFC 5322 msg-ids are opaque', () => {
    expect(normalizeMessageId('<CaF7AbC@Mail.Example.NET>')).toBe('<CaF7AbC@Mail.Example.NET>');
  });

  it('takes the first id when a header carries several', () => {
    expect(normalizeMessageId('<a@x.example> <b@x.example>')).toBe('<a@x.example>');
  });

  it('returns null for empty / bracket-only garbage', () => {
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('   ')).toBeNull();
    expect(normalizeMessageId('<>')).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });
});

describe('parseMessageIdList', () => {
  it('splits a References header into ids in order', () => {
    expect(parseMessageIdList('<a@x.example> <b@x.example>\r\n\t<c@x.example>')).toEqual([
      '<a@x.example>',
      '<b@x.example>',
      '<c@x.example>',
    ]);
  });

  it('accepts an array of header values (repeated headers)', () => {
    expect(parseMessageIdList(['<a@x.example>', '<b@x.example>'])).toEqual([
      '<a@x.example>',
      '<b@x.example>',
    ]);
  });

  it('brackets unbracketed tokens', () => {
    expect(parseMessageIdList('a@x.example b@x.example')).toEqual([
      '<a@x.example>',
      '<b@x.example>',
    ]);
  });

  it('de-duplicates while keeping first-seen order', () => {
    expect(parseMessageIdList('<a@x.example> <b@x.example> <a@x.example>')).toEqual([
      '<a@x.example>',
      '<b@x.example>',
    ]);
  });

  it('is empty for a missing or useless header', () => {
    expect(parseMessageIdList(undefined)).toEqual([]);
    expect(parseMessageIdList('   ')).toEqual([]);
    expect(parseMessageIdList('<>')).toEqual([]);
  });
});
