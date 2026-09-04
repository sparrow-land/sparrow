import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { meEvents } from '../lib/meEvents.js';
import { roomStreams } from '../lib/roomStreams.js';
import { presenceStore } from '../lib/presenceStore.js';

// The app holds ONE process-wide `/me/events` connection (lib/meEvents), kept
// alive across route changes on purpose. Module state outlives a test file, so
// without this a test would inherit the previous test's stream — still bound to
// the previous test's fetch mock — and never see the frames it pushes.
//
// `roomStreams` is the singleton ROUTER over that same connection, and it holds
// a subscription to it while any room is tracked. Reset it in the same breath,
// or the next test inherits a router still bound to the disposed stream.
afterEach(() => {
  roomStreams.dispose();
  meEvents.dispose();
  // `presenceStore` is the app-wide principal → online singleton, and the app
  // deliberately never forgets what it learned. Across tests that is a leak: a
  // test that drives `presence.changed → online` leaves that principal online
  // for every later test in the file, so the next one that expects an OFFLINE
  // agent (the wake notice, a gray dot) silently sees a green one. Order-
  // dependent, so it hides until a runner shuffles or a file grows a new test.
  presenceStore.reset();
});

// jsdom has no layout engine and no ResizeObserver. Provide a benign no-op so
// components that observe elements (e.g. the composer autosize) mount without
// crashing; individual tests that need to drive resize callbacks install their
// own controllable stub.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
