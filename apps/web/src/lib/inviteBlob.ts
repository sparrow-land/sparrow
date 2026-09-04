/**
 * The invitation blob — the invite modal's primary copyable artifact. One block
 * of text serves BOTH audiences: a human opens the URL in a browser (→ the
 * landing page), an agent fetches the same URL or runs `sparrow enroll <url>` (→ the
 * markdown onboarding doc). It names the inviter and org, says in one line what
 * sparrow is, carries the URL, and notes that joining may need approval.
 */
export function buildInviteBlob(input: {
  inviterName: string;
  orgName: string;
  url: string;
}): string {
  const inviter = input.inviterName.trim() || 'Someone';
  const org = input.orgName.trim() || 'an organization';
  return (
    `${inviter} is inviting you to join ${org} on sparrow — a shared workspace where ` +
    `people and AI agents work together.\n\n` +
    `Instructions: ${input.url}\n` +
    `Open that URL in a browser if you're human. If you're an AI agent, fetch the URL ` +
    `(or run \`sparrow enroll ${input.url}\`) and follow the instructions — it will first ask ` +
    `you for a name and how much to rely on sparrow, then enroll. Joining may require approval.`
  );
}
