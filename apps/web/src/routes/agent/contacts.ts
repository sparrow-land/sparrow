/**
 * The external-contact book behind the agent page's trust pills.
 *
 * Trust is a durable, org-scoped fact about an ADDRESS, and the only route that
 * exposes it is `GET /orgs/:orgId/email/contacts` — **org owners/admins only**,
 * because "every external address that has ever written to the org's agents" is
 * exactly the correspondence the timeline restriction protects (SPEC v4, *The
 * email medium → Human / org surfaces*).
 *
 * The Activity and Email tabs, however, are readable by the agent's OWNER too.
 * So an owner who is not an org admin gets **no pill** rather than a 404: a
 * missing pill is already the rendering for "unknown contact" (SPEC: "unknown
 * contacts show nothing"), so the surface degrades into a state the design
 * already defines, and the client never fires a request it knows it may not make
 * (gate render, never discovery).
 */
import { useEffect, useState } from 'react';
import type { ContactTrust, ExternalContact, Party } from '@sparrow/common-types';
import { api } from '../../lib/client.js';

export interface ContactBook {
  /** True once a fetch has settled — pills simply appear when it does. */
  loaded: boolean;
  /** Trust for a timeline entry's `actor.id` (an `ext_` contact id). */
  trustOfContactId(contactId: string | null | undefined): ContactTrust | null;
  /** Trust for a party on an email (by `contactId`, else by address). */
  trustOfParty(party: Party): ContactTrust | null;
  /** The contact behind a timeline actor, when the caller may read contacts. */
  contactById(contactId: string | null | undefined): ExternalContact | null;
}

const EMPTY: ContactBook = {
  loaded: false,
  trustOfContactId: () => null,
  trustOfParty: () => null,
  contactById: () => null,
};

/**
 * One page of contacts (the wire max) — enough to resolve the addresses on a
 * page of activity in a single read. An org with more external correspondents
 * than this simply renders no pill for the overflow, which is the same "unknown"
 * rendering; it never blocks, and never pages the whole address book to draw a
 * pill.
 */
const CONTACT_LIMIT = 100;

export function useContactBook(orgId: string, enabled: boolean): ContactBook {
  const [book, setBook] = useState<ContactBook>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setBook(EMPTY);
      return;
    }
    let cancelled = false;
    void api
      .listEmailContacts(orgId, { limit: CONTACT_LIMIT })
      .then((res) => {
        if (!cancelled) setBook(fromContacts(res.items));
      })
      .catch(() => {
        // Trust is decoration, never the point of the page: a failed read leaves
        // every counterpart looking "unknown" instead of breaking the surface.
        if (!cancelled) setBook({ ...EMPTY, loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, enabled]);

  return book;
}

/** Index a page of contacts by id AND by lowercased address. */
export function fromContacts(items: ExternalContact[]): ContactBook {
  const byId = new Map<string, ExternalContact>();
  const byEmail = new Map<string, ExternalContact>();
  for (const c of items) {
    byId.set(c.id, c);
    byEmail.set(c.email.toLowerCase(), c);
  }
  const contactById = (id: string | null | undefined) => (id ? (byId.get(id) ?? null) : null);
  return {
    loaded: true,
    contactById,
    trustOfContactId: (id) => contactById(id)?.trust ?? null,
    trustOfParty: (party) => {
      const byRef = contactById(party.contactId);
      if (byRef) return byRef.trust;
      return byEmail.get(party.email.toLowerCase())?.trust ?? null;
    },
  };
}
