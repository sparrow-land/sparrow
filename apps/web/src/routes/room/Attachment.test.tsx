import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentMeta } from '@sparrow/common-types';
import { useFetch, restoreFetch, binary, errorJson } from '../../test/apiStub.js';
import { Attachment } from './Attachment.js';

const PNG: AttachmentMeta = {
  id: 'att_img1',
  filename: 'diagram.png',
  contentType: 'image/png',
  sizeBytes: 2048,
};
const SVG: AttachmentMeta = {
  id: 'att_svg1',
  filename: 'logo.svg',
  contentType: 'image/svg+xml',
  sizeBytes: 512,
};
const PDF: AttachmentMeta = {
  id: 'att_pdf1',
  filename: 'report.pdf',
  contentType: 'application/pdf',
  sizeBytes: 4096,
};

const createObjectURL = vi.fn(() => 'blob:mock');
const revokeObjectURL = vi.fn();
let lastBlobType: string | null = null;

/** Serve attachment bytes (or an error) for the download route. */
function stubAttachment(opts: { status?: number; contentType?: string } = {}) {
  useFetch(async (input) => {
    const url = String(input);
    if (url.includes('/attachments/')) {
      if (opts.status) return errorJson('forbidden', opts.status, 'no access');
      return binary(new Uint8Array([1, 2, 3]), opts.contentType ?? 'image/png');
    }
    return errorJson('not_found', 404);
  });
}

beforeEach(() => {
  lastBlobType = null;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      lastBlobType = blob.type;
      return createObjectURL();
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
});
afterEach(() => {
  restoreFetch();
});

describe('Attachment — non-image', () => {
  it('renders a download button and no inline image', async () => {
    stubAttachment();
    render(<Attachment roomId="room_1" meta={PDF} />);
    expect(await screen.findByRole('button', { name: /report\.pdf/i })).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('Attachment — image inline preview', () => {
  it('fetches bytes and renders an inline thumbnail with the filename as alt text', async () => {
    stubAttachment();
    render(<Attachment roomId="room_1" meta={PNG} />);
    const img = await screen.findByRole('img', { name: 'diagram.png' });
    expect(img).toHaveAttribute('src', 'blob:mock');
    expect(createObjectURL).toHaveBeenCalled();
  });

  it('keeps a download affordance near the preview', async () => {
    stubAttachment();
    render(<Attachment roomId="room_1" meta={PNG} />);
    await screen.findByRole('img', { name: 'diagram.png' });
    expect(screen.getByRole('button', { name: /download diagram\.png/i })).toBeInTheDocument();
  });

  it('opens a lightbox on click with a large image, filename, download and close', async () => {
    stubAttachment();
    render(<Attachment roomId="room_1" meta={PNG} />);
    const thumb = await screen.findByRole('button', { name: /view diagram\.png/i });
    await userEvent.click(thumb);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'diagram.png' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /download/i })).toBeInTheDocument();
    // Close via the X button.
    await userEvent.click(within(dialog).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes the lightbox on Escape', async () => {
    stubAttachment();
    render(<Attachment roomId="room_1" meta={PNG} />);
    await userEvent.click(await screen.findByRole('button', { name: /view diagram\.png/i }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('falls back to the plain download row when the image fetch is unauthorized', async () => {
    stubAttachment({ status: 403 });
    render(<Attachment roomId="room_1" meta={PNG} />);
    // No inline image; a download button remains.
    expect(await screen.findByRole('button', { name: /diagram\.png/i })).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});

describe('Attachment — SVG safety', () => {
  it('renders SVG only as an <img> whose blob keeps the image/svg+xml type', async () => {
    stubAttachment({ contentType: 'image/svg+xml' });
    render(<Attachment roomId="room_1" meta={SVG} />);
    const img = await screen.findByRole('img', { name: 'logo.svg' });
    expect(img.tagName).toBe('IMG');
    expect(lastBlobType).toBe('image/svg+xml');
  });
});
