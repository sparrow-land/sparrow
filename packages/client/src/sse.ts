/**
 * Minimal, robust `text/event-stream` (SSE) parser.
 *
 * Feed raw chunks of the response body (already decoded to strings); it buffers
 * partial events across chunk boundaries and returns complete events. Heartbeat
 * comment lines (`:` prefix) and events with no `data:` field are ignored.
 */

export interface RawSSEEvent {
  /** The `event:` name; defaults to `message` per the SSE spec. */
  event: string;
  /** Concatenated `data:` lines (joined with `\n`). */
  data: string;
  /** The `id:` field, if present. */
  id?: string;
}

export class SSEParser {
  private buffer = '';

  /** Feed a decoded chunk; returns any complete events it produced. */
  feed(chunk: string): RawSSEEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const events: RawSSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = SSEParser.parseBlock(raw);
      if (ev) events.push(ev);
    }
    return events;
  }

  private static parseBlock(raw: string): RawSSEEvent | null {
    let event = 'message';
    let id: string | undefined;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line === '' || line.startsWith(':')) continue; // blank or comment/heartbeat
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
      else if (field === 'id') id = value;
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n'), id };
  }
}
