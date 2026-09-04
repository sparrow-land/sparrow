import { describe, it, expect } from 'vitest';
import {
  imageMimeFor,
  isImageAttachment,
  isViewableAttachment,
  isMarkdownAttachment,
  formatBytes,
  stageFiles,
  fileToAttachmentInput,
  type PendingAttachment,
} from './attachments.js';

/** A File whose reported `size` is overridden so tests don't allocate megabytes. */
function fileOf(name: string, size: number, type = 'text/plain'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('imageMimeFor', () => {
  it('recognizes the supported image mime types', () => {
    expect(imageMimeFor('image/png', 'a.png')).toBe('image/png');
    expect(imageMimeFor('image/jpeg', 'a.jpg')).toBe('image/jpeg');
    expect(imageMimeFor('image/gif', 'a.gif')).toBe('image/gif');
    expect(imageMimeFor('image/webp', 'a.webp')).toBe('image/webp');
    expect(imageMimeFor('image/svg+xml', 'a.svg')).toBe('image/svg+xml');
  });

  it('normalizes case and strips parameters', () => {
    expect(imageMimeFor('IMAGE/PNG', 'a.png')).toBe('image/png');
    expect(imageMimeFor('image/svg+xml; charset=utf-8', 'a.svg')).toBe('image/svg+xml');
  });

  it('treats a present, non-image mime as non-image (no extension fallback)', () => {
    // Even though the filename looks like a png, an explicit non-image mime wins.
    expect(imageMimeFor('application/octet-stream', 'sneaky.png')).toBeNull();
    expect(imageMimeFor('text/plain', 'notes.svg')).toBeNull();
  });

  it('falls back to the filename extension only when the mime is absent', () => {
    expect(imageMimeFor('', 'photo.PNG')).toBe('image/png');
    expect(imageMimeFor(null, 'diagram.svg')).toBe('image/svg+xml');
    expect(imageMimeFor(undefined, 'clip.jpeg')).toBe('image/jpeg');
    expect(imageMimeFor('', 'archive.zip')).toBeNull();
    expect(imageMimeFor('', 'noext')).toBeNull();
  });
});

describe('isImageAttachment', () => {
  it('is true for images, false otherwise', () => {
    expect(isImageAttachment('image/png', 'a.png')).toBe(true);
    expect(isImageAttachment('application/pdf', 'a.pdf')).toBe(false);
    expect(isImageAttachment('', 'a.gif')).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

const MB = 1024 * 1024;

describe('stageFiles', () => {
  it('appends valid files to the existing list with metadata', () => {
    const { next, error } = stageFiles([], [fileOf('a.png', 1000, 'image/png')]);
    expect(error).toBeNull();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ filename: 'a.png', contentType: 'image/png', size: 1000 });
    expect(next[0]!.id).toBeTruthy();
    expect(next[0]!.file).toBeInstanceOf(File);
  });

  it('assigns a content type of application/octet-stream when the file has none', () => {
    const { next } = stageFiles([], [fileOf('blob', 5, '')]);
    expect(next[0]!.contentType).toBe('application/octet-stream');
  });

  it('rejects a file larger than 5 MB (naming it) and keeps the rest', () => {
    const big = fileOf('huge.bin', 6 * MB);
    const ok = fileOf('ok.txt', 1000);
    const { next, error } = stageFiles([], [big, ok]);
    expect(next.map((p) => p.filename)).toEqual(['ok.txt']);
    expect(error).toMatch(/huge\.bin/);
    expect(error).toMatch(/5 MB/);
  });

  it('rejects going over 8 total attachments', () => {
    const existing: PendingAttachment[] = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      file: fileOf(`f${i}.txt`, 10),
      filename: `f${i}.txt`,
      contentType: 'text/plain',
      size: 10,
    }));
    const { next, error } = stageFiles(existing, [fileOf('extra.txt', 10)]);
    expect(next).toHaveLength(8);
    expect(error).toMatch(/8/);
  });

  it('rejects exceeding 20 MB total across attachments', () => {
    const existing: PendingAttachment[] = [
      { id: 'p0', file: fileOf('a', 4 * MB), filename: 'a', contentType: 'text/plain', size: 4 * MB },
      { id: 'p1', file: fileOf('b', 4 * MB), filename: 'b', contentType: 'text/plain', size: 4 * MB },
      { id: 'p2', file: fileOf('c', 4 * MB), filename: 'c', contentType: 'text/plain', size: 4 * MB },
      { id: 'p3', file: fileOf('d', 4 * MB), filename: 'd', contentType: 'text/plain', size: 4 * MB },
    ]; // 16 MB staged
    const { next, error } = stageFiles(existing, [fileOf('e', 5 * MB)]); // would be 21 MB
    expect(next).toHaveLength(4);
    expect(error).toMatch(/20 MB/);
  });

  it('gives each staged file a unique id', () => {
    const { next } = stageFiles([], [fileOf('a.txt', 1), fileOf('b.txt', 1)]);
    expect(next[0]!.id).not.toBe(next[1]!.id);
  });
});

describe('fileToAttachmentInput', () => {
  it('base64-encodes the bytes with the filename and content type', async () => {
    const file = new File(['hi bytes'], 'a.txt', { type: 'text/plain' });
    const input = await fileToAttachmentInput(file);
    expect(input).toEqual({
      filename: 'a.txt',
      contentType: 'text/plain',
      dataBase64: Buffer.from('hi bytes').toString('base64'),
    });
  });

  it('falls back to application/octet-stream when the file has no type', async () => {
    const file = new File(['x'], 'noext', { type: '' });
    const input = await fileToAttachmentInput(file);
    expect(input.contentType).toBe('application/octet-stream');
  });
});

describe('isViewableAttachment', () => {
  const MB1 = 1024 * 1024;

  it('accepts text/* content types within the size cap', () => {
    expect(isViewableAttachment('text/markdown', 'notes.md', 100)).toBe(true);
    expect(isViewableAttachment('text/plain', 'notes.txt', 100)).toBe(true);
    expect(isViewableAttachment('text/csv', 'data.csv', 100)).toBe(true);
    expect(isViewableAttachment('TEXT/PLAIN; charset=utf-8', 'a.txt', 100)).toBe(true);
  });

  it('accepts .md/.markdown/.txt filenames even with a non-text mime', () => {
    expect(isViewableAttachment('application/octet-stream', 'README.md', 100)).toBe(true);
    expect(isViewableAttachment('', 'CHANGELOG.markdown', 100)).toBe(true);
    expect(isViewableAttachment(null, 'notes.TXT', 100)).toBe(true);
  });

  it('rejects binary types and non-text extensions', () => {
    expect(isViewableAttachment('application/pdf', 'report.pdf', 100)).toBe(false);
    expect(isViewableAttachment('image/png', 'pic.png', 100)).toBe(false);
    expect(isViewableAttachment('', 'archive.zip', 100)).toBe(false);
    expect(isViewableAttachment('', 'noext', 100)).toBe(false);
  });

  it('rejects anything over 1 MB', () => {
    expect(isViewableAttachment('text/plain', 'big.txt', MB1 + 1)).toBe(false);
    expect(isViewableAttachment('text/plain', 'edge.txt', MB1)).toBe(true);
  });
});

describe('isMarkdownAttachment', () => {
  it('is true for text/markdown and .md/.markdown filenames', () => {
    expect(isMarkdownAttachment('text/markdown', 'x.bin')).toBe(true);
    expect(isMarkdownAttachment('text/plain', 'README.md')).toBe(true);
    expect(isMarkdownAttachment('', 'doc.markdown')).toBe(true);
  });

  it('is false for plain text and other types', () => {
    expect(isMarkdownAttachment('text/plain', 'notes.txt')).toBe(false);
    expect(isMarkdownAttachment('application/pdf', 'a.pdf')).toBe(false);
  });
});
