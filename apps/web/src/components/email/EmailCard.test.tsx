import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { useFetch, restoreFetch, json, errorJson } from '../../test/apiStub.js';
import { email, party, preview, threadRef, verification, ORG_ID } from '../../test/fixtures.js';
import { headFromEmail, headFromPreview, type EmailCardHead } from '../../lib/email.js';
import { EmailCard } from './EmailCard.js';
import type { Email } from '@sparrow/common-types';

/** The card with local expansion state, as every surface drives it. */
function Harness({
  head,
  full,
  ...rest
}: {
  head: EmailCardHead;
  full?: Email | null;
  trust?: 'approved' | 'blocked' | null;
  threadHref?: string | null;
  reviewHref?: string | null;
  startExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(rest.startExpanded ?? false);
  return (
    <MemoryRouter>
      <EmailCard
        orgId={ORG_ID}
        head={head}
        full={full ?? null}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        {...rest}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  restoreFetch();
  vi.restoreAllMocks();
});

describe('EmailCard — collapsed', () => {
  it('reads direction, counterpart, subject, snippet and time in one row', () => {
    render(<Harness head={headFromPreview(preview())} />);
    const row = screen.getByRole('button', { name: /received email from dana lee/i });
    expect(within(row).getByText('Re: Q3 rollout')).toBeInTheDocument();
    expect(within(row).getByText(/the plan is attached/)).toBeInTheDocument();
  });

  it('carries no disposition badge on the happy path', () => {
    render(<Harness head={headFromPreview(preview({ disposition: 'delivered' }))} />);
    expect(screen.queryByText(/quarantined|held|rejected|send failed/i)).toBeNull();
  });

  // The happy path is exactly when nothing else says "this is not chat": no
  // badge, no error, just a box. The medium mark has to carry that on its own.
  it('marks the medium on the collapsed row, badge or no badge', () => {
    for (const disposition of ['delivered', 'held'] as const) {
      const view = render(<Harness head={headFromPreview(preview({ disposition }))} />);
      const glyph = screen.getByTestId('medium-glyph');
      expect(glyph).toHaveAttribute('data-medium', 'email');
      // Glyph plus its word — the same rule the direction glyph follows.
      expect(glyph).toHaveTextContent('Email');
      view.unmount();
    }
  });

  it('puts the medium mark AHEAD of the direction glyph on the row', () => {
    render(<Harness head={headFromPreview(preview())} />);
    const row = screen.getByRole('button', { name: /received email from dana lee/i });
    const glyph = screen.getByTestId('medium-glyph');
    // "What kind of box is this" reads before "which way did it go".
    expect(row.firstElementChild).toBe(glyph);
  });

  it('badges quarantined / held / rejected / send-failed', () => {
    const cases = [
      ['quarantined', 'Quarantined'],
      ['held', 'Held'],
      ['rejected', 'Rejected'],
      ['send-failed', 'Send failed'],
    ] as const;
    for (const [disposition, label] of cases) {
      const view = render(<Harness head={headFromPreview(preview({ disposition }))} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      view.unmount();
    }
  });

  it('shows a quiet trust pill for a known external contact, nothing for an unknown one', () => {
    const view = render(<Harness head={headFromPreview(preview())} trust="approved" />);
    expect(screen.getByText('trusted')).toBeInTheDocument();
    view.unmount();

    const blocked = render(<Harness head={headFromPreview(preview())} trust="blocked" />);
    expect(screen.getByText('blocked')).toBeInTheDocument();
    blocked.unmount();

    render(<Harness head={headFromPreview(preview())} trust={null} />);
    expect(screen.queryByText(/trusted|blocked/)).toBeNull();
  });

  it('offers a Review link on a pending card the viewer may act on', () => {
    render(
      <Harness
        head={headFromPreview(preview({ disposition: 'quarantined' }))}
        reviewHref="/me/approvals"
      />,
    );
    expect(screen.getByRole('link', { name: /review/i })).toHaveAttribute('href', '/me/approvals');
  });

  it('offers no Review link on a delivered card', () => {
    render(<Harness head={headFromPreview(preview())} reviewHref="/me/approvals" />);
    expect(screen.queryByRole('link', { name: /review/i })).toBeNull();
  });

  it('is a borderless Tinted Etch box in the email tone, type a notch down', () => {
    const { container } = render(<Harness head={headFromPreview(preview())} />);
    const box = container.querySelector<HTMLElement>('.info-box');
    expect(box).not.toBeNull();
    expect(box!.style.getPropertyValue('--info-tone')).toBe('var(--sparrow-type-email)');
    expect(box!.className).not.toContain('border-[var(--sparrow-border)]');
    expect(box!.className).not.toContain('bg-[var(--sparrow-panel)]');
    // The sentence steps down one notch with the family…
    expect(screen.getByText('Re: Q3 rollout').className).toContain('text-xs');
  });

  it('holds the email row at its floor density — the badge and Review link keep their air', () => {
    // The email box does NOT take the full compact row the hint takes: its
    // controls (disposition pill, Review link) set a minimum comfortable
    // height, so the row keeps the shipped padding rather than py-[5px].
    render(
      <Harness
        head={headFromPreview(preview({ disposition: 'held' }))}
        reviewHref="/me/approvals"
      />,
    );
    const row = screen.getByRole('button', { name: /received email/i }).parentElement!;
    expect(row.className).toContain('py-1.5');
    expect(row.className).not.toContain('py-[5px]');
    // Both controls coexist on the row at that density.
    expect(within(row).getByText('Held')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /review/i })).toBeInTheDocument();
  });
});

describe('EmailCard — expanded', () => {
  it('fetches the full email once expanded and renders participants including cc', async () => {
    useFetch(
      vi.fn(async () =>
        json({
          email: email({
            cc: [party({ email: 'sam@partner.example.com', name: 'Sam', contactId: 'ext_sam' })],
          }),
        }),
      ) as unknown as typeof fetch,
    );
    render(<Harness head={headFromPreview(preview())} />);
    await userEvent.click(screen.getByRole('button', { name: /received email from dana lee/i }));

    expect(await screen.findByText(/^from$/i)).toBeInTheDocument();
    expect(screen.getByText(/^to$/i)).toBeInTheDocument();
    expect(screen.getByText(/^cc$/i)).toBeInTheDocument();
    expect(screen.getByText('Sam')).toBeInTheDocument();
    // There is never a Bcc row: `bcc` is always [] in v4, in both directions.
    expect(screen.queryByText(/^bcc$/i)).toBeNull();
  });

  it('names the medium in view once the card is open', async () => {
    render(<Harness head={headFromEmail(email())} full={email()} startExpanded />);
    const mark = await screen.findByTestId('medium-mark');
    expect(mark).toHaveAttribute('data-medium', 'email');
    expect(mark).toHaveTextContent('Email');
  });

  it('still names the medium when the body could not be loaded', async () => {
    useFetch(vi.fn(async () => errorJson('not_found', 404)) as unknown as typeof fetch);
    render(<Harness head={headFromPreview(preview())} startExpanded />);
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    // The register is a fact about the ENTRY, not about the body we fetched.
    expect(screen.getByTestId('medium-mark')).toHaveTextContent('Email');
  });

  it('renders no cc row when there is no cc', async () => {
    render(<Harness head={headFromEmail(email())} full={email()} startExpanded />);
    expect(await screen.findByText(/^from$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^cc$/i)).toBeNull();
  });

  it('renders the HTML body in a style-isolated container that scrolls inside itself', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email({ html: '<p>hello <a href="https://example.com">link</a></p>' })}
        startExpanded
      />,
    );
    const body = await screen.findByTestId('email-body');
    expect(body.className).toContain('overflow-x-auto');
    expect(body.querySelector('a')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(body.querySelector('a')).toHaveAttribute('target', '_blank');
  });

  it('loads no remote content and executes nothing from the body', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email({
          html: '<p>hi</p><img src="https://tracker.example.com/p.gif"><script>evil()</script>',
        })}
        startExpanded
      />,
    );
    const body = await screen.findByTestId('email-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('script')).toBeNull();
    expect(body.innerHTML).not.toContain('tracker.example.com');
  });

  it('renders plain text pre-wrapped when there is no HTML body', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email({ html: null, text: 'line one\nline two' })}
        startExpanded
      />,
    );
    const body = await screen.findByTestId('email-body');
    expect(body.textContent).toContain('line one');
    expect(body.querySelector('pre')).not.toBeNull();
  });

  it('shows the verification indicator with per-mechanism detail in the tooltip text', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email({ verification: verification({ dkim: 'fail' }) })}
        startExpanded
      />,
    );
    const mark = await screen.findByText('Unverified sender');
    expect(mark.getAttribute('title')).toContain('DKIM: fail');
  });

  it('shows the judge verdict and reason, never the provider', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email({ judge: { verdict: 'deny', reason: 'asks for credentials', provider: 'anthropic' } })}
        startExpanded
      />,
    );
    expect(await screen.findByText(/automatic review: deny — asks for credentials/i)).toBeInTheDocument();
    expect(screen.queryByText(/anthropic/i)).toBeNull();
  });

  it('deep-links Open thread into the agent page’s Email section', async () => {
    render(
      <Harness
        head={headFromEmail(email())}
        full={email()}
        startExpanded
        threadHref="/org/1/agents/1?tab=email&thread=eth_1"
      />,
    );
    expect(await screen.findByRole('link', { name: /open thread/i })).toHaveAttribute(
      'href',
      '/org/1/agents/1?tab=email&thread=eth_1',
    );
  });

  it('collapses again on a second click', async () => {
    render(<Harness head={headFromEmail(email())} full={email()} />);
    const row = screen.getByRole('button', { name: /received email from/i });
    await userEvent.click(row);
    expect(await screen.findByTestId('email-body')).toBeInTheDocument();
    await userEvent.click(row);
    await waitFor(() => expect(screen.queryByTestId('email-body')).toBeNull());
  });

  it('tolerates a 404 from the medium fetch, rendering the entry’s own facts', async () => {
    useFetch(vi.fn(async () => errorJson('not_found', 404)) as unknown as typeof fetch);
    render(<Harness head={{ ...headFromPreview(preview()), snippet: null }} />);
    await userEvent.click(screen.getByRole('button', { name: /received email from/i }));
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    // The subject (from the entry/preview) still reads.
    expect(screen.getByText('Re: Q3 rollout')).toBeInTheDocument();
  });

  it('never renders a receipt, presence, or working status behind an address', async () => {
    render(<Harness head={headFromEmail(email())} full={email()} startExpanded />);
    await screen.findByTestId('email-body');
    expect(screen.queryByText(/delivered ·|read \(|working/i)).toBeNull();
  });
});

describe('EmailCard — outbound', () => {
  it('names the recipient and shows no verification indicator on own outbound mail', async () => {
    const out = email({
      direction: 'out',
      from: party({ email: 'fable@acme.example.com', name: 'fable', contactId: null }),
      to: [party()],
      verification: null,
      disposition: 'sent',
      status: 'read',
    });
    render(<Harness head={headFromEmail(out)} full={out} startExpanded />);
    expect(screen.getByRole('button', { name: /sent email to dana lee/i })).toBeInTheDocument();
    await screen.findByTestId('email-body');
    expect(screen.queryByText(/verified —|unverified sender/i)).toBeNull();
  });
});

describe('EmailCard — thread ref helper', () => {
  it('uses the thread subject when an email re-subjects', () => {
    // A reply may re-subject; its own subject shows on the card.
    const t = threadRef({ subject: 'Q3 rollout' });
    const e = email({ subject: 'Re: Q3 rollout — revised', threadId: t.id });
    render(<Harness head={headFromEmail(e)} full={e} />);
    expect(screen.getByText('Re: Q3 rollout — revised')).toBeInTheDocument();
  });
});

describe('EmailCard — copy the body', () => {
  function stubClipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    return writeText;
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  // Email is not markdown, so "the raw body" here is the plain-text part.
  it('copies the email body text from the opened card', async () => {
    const writeText = stubClipboard();
    render(<Harness head={headFromEmail(email())} full={email()} startExpanded />);
    await screen.findByTestId('email-body');
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('the plan is attached, let me know what you think');
  });

  it('shows no copy affordance on a collapsed card', () => {
    stubClipboard();
    render(<Harness head={headFromEmail(email())} full={email()} />);
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });
});
