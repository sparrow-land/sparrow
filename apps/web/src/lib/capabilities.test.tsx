import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useFetch, restoreFetch, json, errorJson } from '../test/apiStub.js';
import { CapabilitiesProvider, useCapabilities } from './capabilities.js';

function Probe() {
  const { voice } = useCapabilities();
  return <div data-testid="caps">{`${voice.stt}:${voice.tts}`}</div>;
}

function EmailProbe() {
  const { email } = useCapabilities();
  return <div data-testid="email">{String(email)}</div>;
}

function ReviewerProbe() {
  const { emailReviewer } = useCapabilities();
  return <div data-testid="reviewer">{String(emailReviewer)}</div>;
}

afterEach(() => restoreFetch());

describe('CapabilitiesProvider', () => {
  it('exposes the fetched capabilities', async () => {
    useFetch(async () => json({ voice: { stt: true, tts: true } }));
    render(
      <CapabilitiesProvider>
        <Probe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('caps')).toHaveTextContent('true:true'));
  });

  it('falls back to all-off when the fetch fails, and still renders children', async () => {
    useFetch(async () => errorJson('not_found', 404));
    render(
      <CapabilitiesProvider>
        <Probe />
      </CapabilitiesProvider>,
    );
    // Children render immediately with the safe default; a failed fetch leaves it.
    expect(screen.getByTestId('caps')).toHaveTextContent('false:false');
    // The provider settles to `loaded` (still all-off) after the failed fetch.
    await waitFor(() => expect(screen.getByTestId('caps')).toHaveTextContent('false:false'));
  });

  it('returns the all-off default with no provider mounted', () => {
    render(<Probe />);
    expect(screen.getByTestId('caps')).toHaveTextContent('false:false');
  });

  // v4: the email medium is gated exactly like voice — render is gated, discovery
  // never is. An instance without the medium must read `false`, including when
  // `GET /capabilities` predates the field or never answers at all.
  it('email defaults off (no provider, failed fetch, or a server that omits the field)', async () => {
    const bare = render(<EmailProbe />);
    expect(bare.getByTestId('email')).toHaveTextContent('false');
    bare.unmount();

    useFetch(async () => errorJson('not_found', 404));
    const failed = render(
      <CapabilitiesProvider>
        <EmailProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(failed.getByTestId('email')).toHaveTextContent('false'));
    failed.unmount();

    useFetch(async () => json({ voice: { stt: false, tts: false } }));
    const omitted = render(
      <CapabilitiesProvider>
        <EmailProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(omitted.getByTestId('email')).toHaveTextContent('false'));
  });

  it('exposes email: true when the server advertises the medium', async () => {
    useFetch(async () => json({ email: true, voice: { stt: false, tts: false } }));
    render(
      <CapabilitiesProvider>
        <EmailProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('email')).toHaveTextContent('true'));
  });

  // v4: `emailReviewer` is not a medium but a fact ABOUT one — whether an LLM
  // judge is registered here. It gates no surface; it lets org admin state the
  // degrade-to-approve rule instead of hedging, so its safe default is "none".
  it('emailReviewer defaults off (no provider, failed fetch, or a server that omits the field)', async () => {
    const bare = render(<ReviewerProbe />);
    expect(bare.getByTestId('reviewer')).toHaveTextContent('false');
    bare.unmount();

    useFetch(async () => errorJson('not_found', 404));
    const failed = render(
      <CapabilitiesProvider>
        <ReviewerProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(failed.getByTestId('reviewer')).toHaveTextContent('false'));
    failed.unmount();

    useFetch(async () => json({ email: true, voice: { stt: false, tts: false } }));
    const omitted = render(
      <CapabilitiesProvider>
        <ReviewerProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(omitted.getByTestId('reviewer')).toHaveTextContent('false'));
  });

  it('exposes emailReviewer: true when a judge is registered — independently of email', async () => {
    useFetch(async () =>
      json({ email: false, emailReviewer: true, voice: { stt: false, tts: false } }),
    );
    render(
      <CapabilitiesProvider>
        <EmailProbe />
        <ReviewerProbe />
      </CapabilitiesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('reviewer')).toHaveTextContent('true'));
    expect(screen.getByTestId('email')).toHaveTextContent('false');
  });
});
