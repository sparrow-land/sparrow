import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { pageTitle, useDocumentTitle, DEFAULT_TITLE } from './title.js';

afterEach(() => {
  cleanup();
  document.title = DEFAULT_TITLE;
});

describe('pageTitle', () => {
  it('suffixes the product name', () => {
    expect(pageTitle('Sign in')).toBe('Sign in — sparrow');
  });

  it('nests multiple parts left-to-right', () => {
    expect(pageTitle('Settings', '#general')).toBe('Settings — #general — sparrow');
  });

  it('drops blank/absent parts instead of leaving a dangling separator', () => {
    expect(pageTitle(null)).toBe('sparrow');
    expect(pageTitle(undefined, '   ')).toBe('sparrow');
    expect(pageTitle('', 'Acme')).toBe('Acme — sparrow');
  });
});

describe('useDocumentTitle', () => {
  function Page({ title }: { title: string | null }) {
    useDocumentTitle(title);
    return null;
  }

  it('sets document.title while mounted', () => {
    render(<Page title="Sign in — sparrow" />);
    expect(document.title).toBe('Sign in — sparrow');
  });

  it('restores the previous title on unmount', () => {
    document.title = DEFAULT_TITLE;
    const view = render(<Page title="Sign in — sparrow" />);
    expect(document.title).toBe('Sign in — sparrow');
    view.unmount();
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it('leaves the title alone while the subject is still loading (null)', () => {
    document.title = DEFAULT_TITLE;
    render(<Page title={null} />);
    expect(document.title).toBe(DEFAULT_TITLE);
  });

  it('follows the title when it changes (subject loads in)', () => {
    const view = render(<Page title={pageTitle(null)} />);
    expect(document.title).toBe('sparrow');
    view.rerender(<Page title={pageTitle('#general')} />);
    expect(document.title).toBe('#general — sparrow');
  });
});
