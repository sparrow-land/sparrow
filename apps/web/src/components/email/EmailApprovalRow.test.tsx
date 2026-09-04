import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useFetch, restoreFetch, json } from '../../test/apiStub.js';
import { approvalItem, email, party, preview, ORG_ID } from '../../test/fixtures.js';
import { EmailApprovalRow } from './EmailApprovalRow.js';
import type { EmailApprovalItem } from '@sparrow/common-types';

interface Recorder {
  calls: { method: string; url: string; body: unknown }[];
}

function mockApi(rec: Recorder) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') rec.calls.push({ method, url, body });
    if (url.includes('/approve')) return json({ email: email({ disposition: 'delivered' }) });
    if (url.includes('/deny')) return json({ email: email({ disposition: 'rejected', reason: 'denied' }) });
    if (url.includes('/email/emails/')) return json({ email: email() });
    return json({ error: { code: 'not_found', message: url } }, 404);
  }) as unknown as typeof fetch;
}

function renderRow(item: EmailApprovalItem = approvalItem(), props: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <EmailApprovalRow orgId={ORG_ID} item={item} {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('EmailApprovalRow — the affordances', () => {
  it('shows the row: direction, agent, counterpart, subject, snippet, time', () => {
    renderRow();
    // An inbound approval row is an UNTRUSTED sender: the raw address renders,
    // never the self-chosen "Dana Lee" (Jake's ruling, 2026-09-02).
    expect(
      screen.getByRole('button', { name: /received email from dana@partner\.example\.com/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('fable')).toBeInTheDocument();
    expect(screen.getByText('Re: Q3 rollout')).toBeInTheDocument();
    expect(screen.getByText('Quarantined')).toBeInTheDocument();
  });

  it('shows the verification indicator with the mechanisms in the tooltip', () => {
    renderRow();
    const mark = screen.getByText('Unverified sender');
    expect(mark.getAttribute('title')).toContain('SPF: fail');
  });

  it('approve is primary, with "Also trust …" CHECKED by default', () => {
    renderRow();
    const trust = screen.getByRole('checkbox', { name: /also trust dana@partner\.example\.com from now on/i });
    expect(trust).toBeChecked();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
  });

  it('approving with the box checked sends no trustSender override (durable by default)', async () => {
    const rec: Recorder = { calls: [] };
    useFetch(mockApi(rec));
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(rec.calls.some((c) => c.url.includes('/approve'))).toBe(true));
    expect(rec.calls.find((c) => c.url.includes('/approve'))?.body).toEqual({});
  });

  it('unchecking the trust box sends { trustSender: false } — a one-time pass', async () => {
    const rec: Recorder = { calls: [] };
    useFetch(mockApi(rec));
    renderRow();
    await userEvent.click(screen.getByRole('checkbox', { name: /also trust/i }));
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(rec.calls.some((c) => c.url.includes('/approve'))).toBe(true));
    expect(rec.calls.find((c) => c.url.includes('/approve'))?.body).toEqual({ trustSender: false });
  });

  // An outbound hold's unrecognized recipients are not on the preview (its
  // `from` is the agent's own address), so the checkbox uses the spec's plural
  // variant rather than naming an address the surface does not have.
  it('offers the plural trust copy on an outbound hold', () => {
    renderRow(
      approvalItem({
        email: preview({
          direction: 'out',
          disposition: 'held',
          reason: 'unrecognized-recipient',
          from: party({ email: 'fable@acme.example.com', name: 'fable', contactId: null }),
        }),
        verification: null,
      }),
    );
    expect(screen.getByRole('checkbox', { name: /also trust .* from now on/i })).toBeInTheDocument();
    expect(screen.getByText('Held')).toBeInTheDocument();
  });

  it('deny opens a confirm carrying an UNCHECKED block box and final-resolution copy', async () => {
    useFetch(mockApi({ calls: [] }));
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    const block = screen.getByRole('checkbox', { name: /block dana@partner\.example\.com/i });
    expect(block).not.toBeChecked();
    // The copy says plainly that this is final, BEFORE the click.
    expect(screen.getByText(/can’t be undone|cannot be undone/i)).toBeInTheDocument();
  });

  it('denying with the block box checked sends { blockSender: true }', async () => {
    const rec: Recorder = { calls: [] };
    useFetch(mockApi(rec));
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /^block /i }));
    await userEvent.click(screen.getByRole('button', { name: /deny (and block|this email)/i }));
    await waitFor(() => expect(rec.calls.some((c) => c.url.includes('/deny'))).toBe(true));
    expect(rec.calls.find((c) => c.url.includes('/deny'))?.body).toEqual({ blockSender: true });
  });
});

describe('EmailApprovalRow — resolution is final', () => {
  it('collapses in place to "Delivered — sender trusted" after approving inbound', async () => {
    useFetch(mockApi({ calls: [] }));
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/delivered — sender trusted/i);
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('collapses to "Delivered" when the one-time pass was used', async () => {
    useFetch(mockApi({ calls: [] }));
    renderRow();
    await userEvent.click(screen.getByRole('checkbox', { name: /also trust/i }));
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Delivered$/);
  });

  it('collapses to "Rejected" after denying inbound', async () => {
    useFetch(mockApi({ calls: [] }));
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    await userEvent.click(screen.getByRole('button', { name: /deny (and block|this email)/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Rejected$/);
  });

  it('collapses to "Sent" / "Not sent" for an outbound hold', async () => {
    useFetch(mockApi({ calls: [] }));
    const outbound = approvalItem({
      email: preview({ direction: 'out', disposition: 'held', reason: 'unrecognized-recipient' }),
      verification: null,
    });
    const view = renderRow(outbound);
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Sent$/);
    view.unmount();

    renderRow(outbound);
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    await userEvent.click(screen.getByRole('button', { name: /deny (and block|this email)/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Not sent$/);
  });

  it('resolves in place when SOMEONE ELSE acted first (a live email.resolved)', () => {
    renderRow(approvalItem(), {
      resolution: { resolution: 'approved', by: { id: 'usr_2', displayName: 'Mira' } },
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^Delivered/);
    expect(screen.getByRole('status')).toHaveTextContent(/Mira/);
    expect(screen.queryByRole('button', { name: /^approve$/i })).toBeNull();
  });

  it('reports a failure inline and leaves the row actionable', async () => {
    useFetch(
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/approve')
          ? json({ error: { code: 'conflict', message: 'Already resolved' } }, 409)
          : json({ error: { code: 'not_found', message: 'x' } }, 404),
      ) as unknown as typeof fetch,
    );
    renderRow();
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/already resolved/i)).toBeInTheDocument();
  });
});
