import { describe, expect, it } from 'vitest';
import { SSEParser } from './sse.js';

describe('SSEParser', () => {
  it('parses a single named event with JSON data', () => {
    const p = new SSEParser();
    const events = p.feed('event: message.new\ndata: {"a":1}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: 'message.new', data: '{"a":1}' });
  });

  it('defaults event name to message', () => {
    const p = new SSEParser();
    const events = p.feed('data: hi\n\n');
    expect(events[0]!.event).toBe('message');
  });

  it('buffers events split across chunks', () => {
    const p = new SSEParser();
    expect(p.feed('event: x\ndata: {"v":')).toHaveLength(0);
    const events = p.feed('42}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('{"v":42}');
  });

  it('ignores heartbeat comments and empty data blocks', () => {
    const p = new SSEParser();
    const events = p.feed(': heartbeat\n\nevent: a\ndata: 1\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.event).toBe('a');
  });

  it('joins multiple data lines with newline', () => {
    const p = new SSEParser();
    const events = p.feed('data: line1\ndata: line2\n\n');
    expect(events[0]!.data).toBe('line1\nline2');
  });

  it('handles CRLF line endings', () => {
    const p = new SSEParser();
    const events = p.feed('event: x\r\ndata: y\r\n\r\n');
    expect(events[0]).toMatchObject({ event: 'x', data: 'y' });
  });
});
