import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttachmentMeta } from '@sparrow/common-types';
import { useFetch, restoreFetch, binary, errorJson } from '../../test/apiStub.js';
import { Attachment } from './Attachment.js';

const MD: AttachmentMeta = {
  id: 'att_md1',
  filename: 'notes.md',
  contentType: 'text/markdown',
  sizeBytes: 512,
};
const TXT: AttachmentMeta = {
  id: 'att_txt1',
  filename: 'log.txt',
  contentType: 'text/plain',
  sizeBytes: 256,
};
const BIG_TXT: AttachmentMeta = {
  id: 'att_big1',
  filename: 'huge.txt',
  contentType: 'text/plain',
  sizeBytes: 2 * 1024 * 1024,
};
const PDF: AttachmentMeta = {
  id: 'att_pdf1',
  filename: 'report.pdf',
  contentType: 'application/pdf',
  sizeBytes: 4096,
};

/** Serve UTF-8 text (or an error) for the attachment download route. */
function stubText(content: string, opts: { status?: number; contentType?: string } = {}) {
  useFetch(async (input) => {
    const url = String(input);
    if (url.includes('/attachments/')) {
      if (opts.status) return errorJson('forbidden', opts.status, 'no access');
      return binary(new TextEncoder().encode(content), opts.contentType ?? 'text/plain');
    }
    return errorJson('not_found', 404);
  });
}

afterEach(() => {
  restoreFetch();
});

describe('viewable text attachments', () => {
  it('offers a View affordance and opens a modal with the fetched content', async () => {
    stubText('Hello attachment world', { contentType: 'text/markdown' });
    render(<Attachment roomId="room_1" meta={MD} />);

    await userEvent.click(screen.getByRole('button', { name: /view notes\.md/i }));
    const dialog = await screen.findByRole('dialog');
    // Filename as the modal title.
    expect(within(dialog).getByText('notes.md')).toBeInTheDocument();
    // Fetched content rendered in the body.
    expect(await within(dialog).findByText(/Hello attachment world/)).toBeInTheDocument();
    // Download stays available as a secondary action.
    expect(within(dialog).getByRole('button', { name: /download/i })).toBeInTheDocument();
  });

  it('renders .txt content literally in a pre block (no markdown transform)', async () => {
    stubText('# not a heading\n*not emphasis*');
    render(<Attachment roomId="room_1" meta={TXT} />);

    await userEvent.click(screen.getByRole('button', { name: /view log\.txt/i }));
    const dialog = await screen.findByRole('dialog');
    const literal = await within(dialog).findByText(/# not a heading/);
    expect(literal.closest('pre')).not.toBeNull();
  });

  it('keeps a secondary download affordance on the chip itself', async () => {
    stubText('x');
    render(<Attachment roomId="room_1" meta={TXT} />);
    expect(screen.getByRole('button', { name: /download log\.txt/i })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    stubText('content');
    render(<Attachment roomId="room_1" meta={TXT} />);
    await userEvent.click(screen.getByRole('button', { name: /view log\.txt/i }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes via the backdrop', async () => {
    stubText('content');
    render(<Attachment roomId="room_1" meta={TXT} />);
    await userEvent.click(screen.getByRole('button', { name: /view log\.txt/i }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByTestId('modal-backdrop'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a friendly error with a download fallback when the fetch fails', async () => {
    stubText('', { status: 403 });
    render(<Attachment roomId="room_1" meta={TXT} />);
    await userEvent.click(screen.getByRole('button', { name: /view log\.txt/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/couldn.t load/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /download/i })).toBeInTheDocument();
  });
});

describe('non-viewable attachments keep download-only behavior', () => {
  it('offers no View affordance for oversized text files', async () => {
    stubText('x'.repeat(10));
    render(<Attachment roomId="room_1" meta={BIG_TXT} />);
    expect(screen.queryByRole('button', { name: /view huge\.txt/i })).toBeNull();
    // The plain download row remains.
    expect(screen.getByRole('button', { name: /huge\.txt/i })).toBeInTheDocument();
  });

  it('offers no View affordance for binary content types', async () => {
    stubText('x');
    render(<Attachment roomId="room_1" meta={PDF} />);
    expect(screen.queryByRole('button', { name: /view report\.pdf/i })).toBeNull();
    expect(screen.getByRole('button', { name: /report\.pdf/i })).toBeInTheDocument();
  });
});
