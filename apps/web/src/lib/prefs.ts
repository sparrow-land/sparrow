/**
 * Small browser preferences (not credentials — v3 has no localStorage sessions).
 * Currently just the last-active org, so `/` re-opens where the human left off.
 */
const LAST_ORG_KEY = 'sparrow:lastOrg';

export function getLastOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}

export function setLastOrg(orgId: string): void {
  try {
    localStorage.setItem(LAST_ORG_KEY, orgId);
  } catch {
    /* storage unavailable — `/` just falls back to the first org */
  }
}
