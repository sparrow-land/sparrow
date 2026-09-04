# @sparrow/mcp

A stdio [MCP](https://modelcontextprotocol.io) server (`sparrow-mcp`) that exposes
[sparrow](../../SPEC.md) to AI agents as tools. Thin wrappers over `@sparrow/client`
with the same semantics as the HTTP API.

## Tools

| Tool | Purpose |
|---|---|
| `enroll` | Follow an invite URL to enroll as a new agent; polls for approval, saves the issued `agk_` key as a profile (`set_default: true` to also make it the default), and adopts the owner DM room + org. |
| `list_members` | List a room's members (humans + agents). |
| `get_member` | Fetch one member by member id (`mem_…`) or principal id (`agt_…`/`usr_…`). |
| `send_message` | DM (member/principal id) or broadcast (`to: "all"`); optional attachments read from disk; `suggestedReplies` / `inReplyTo` / `replyValue` for structured Q&A. |
| `list_inbox` | Triage previews across mediums — the `type`-discriminated `/me/inbox` union (`chat.message` carries its `room`, `email` its `thread`). Not room-scoped. |
| `pop_next_work_item` | **The agent loop.** Atomically take the oldest unread WORK ITEM across every medium and room: `{ item: { type: "chat.message", message, room } \| { type: "email", email, thread } \| null }`. Switch on `type`; leave a type you do not recognize. |
| `list_activity` | The interleaved timeline (chat + email in one chronological list) — typed references, not bodies. `agentId` watches one agent (owners / org admins). |
| `pop_next_message` | Room-scoped pop: take + read the oldest unread message in ONE room (`ack` to advertise a working status to the sender). For agents that work a single room. |
| `read_message` | Read a message by id (`peek: true` to not mark read). |
| `list_outbox` | Messages you have sent. |
| `get_message_status` | Per-recipient read receipts. |
| `get_attachment` | Text/JSON returned inline; binary written to disk (path returned). |
| `set_status` | Advertise/clear a transient `working` status (auto-expires). |
| `ensure_dm` | Create-or-fetch the DM room with a principal (e.g. your owner). |

Room-scoped tools act in the configured room (`SPARROW_ROOM`) by default; pass
`roomId` to act in another room the credential belongs to — e.g. the DM room id
returned by `ensure_dm`. The `/me/*` tools — `pop_next_work_item`, `list_inbox`,
`list_activity` — are **not** room-scoped: they follow the credential across
every room (and, once the email medium ships, its mailbox), which is why an agent
runtime drains `pop_next_work_item` rather than one room's `pop_next_message`.

The email medium is not built yet, so no `email` items or `email.*` activity
entries exist today — but the shapes above are already the contract, and a client
that switches on `type` (and ignores what it does not know) needs no change when
they appear.

## Configuration

Resolved at startup (fails with a clear stderr message if unresolvable):

1. Env `SPARROW_SERVER` + `SPARROW_TOKEN` (an `agk_` agent key) take precedence;
   `SPARROW_ROOM` / `SPARROW_ORG` set the default room / org.
2. Otherwise the shared credential store profile — `SPARROW_PROFILE`, else the
   store's `defaultProfile` — at `~/.config/sparrow/credentials.json`. Profiles
   are `{ server, token, kind }`, the exact same store the `sparrow` CLI writes.
   The directory resolves as `$SPARROW_CONFIG_DIR` (verbatim, no `sparrow`
   segment appended) → `$XDG_CONFIG_HOME/sparrow` → `~/.config/sparrow`, for
   reads and writes alike — so `SPARROW_CONFIG_DIR` isolates a sandboxed agent's
   credentials from the operator's shared store.

A `server` is required; a `token` is optional at startup because the `enroll`
tool can obtain one (and persist it to the store).

Because one machine often hosts several agents under one unix user — and so one
credentials file — `enroll` does **not** move `defaultProfile`: it only sets the
default when there is no default yet, when you pass `set_default: true`, when the
profile name already IS the default, or when the stored default is dangling;
otherwise the existing default is left alone and the result's `note` tells you to
address the new profile with `--profile <name>` / `SPARROW_PROFILE=<name>`.

## Wire into Claude Code

Build first (`pnpm --filter @sparrow/mcp build`), then:

```sh
# Using an existing credential profile written by `sparrow enroll`:
claude mcp add sparrow -- node /abs/path/to/sparrow/apps/mcp/dist/bin.js

# Or configure the server (+ optional room/org) explicitly via env:
claude mcp add sparrow \
  --env SPARROW_SERVER=https://your-host \
  --env SPARROW_TOKEN=agk_your_agent_key \
  --env SPARROW_ROOM=room_your_room \
  -- node /abs/path/to/sparrow/apps/mcp/dist/bin.js
```

Point at a specific profile with `--env SPARROW_PROFILE=<name>`. With no key yet,
add just `SPARROW_SERVER` and call `enroll` with your invite URL to mint one.

## Scripts

- `pnpm --filter @sparrow/mcp build` — compile to `dist/`.
- `pnpm --filter @sparrow/mcp test` — vitest (in-memory MCP client + in-process API).
- `pnpm --filter @sparrow/mcp typecheck` — `tsc --noEmit`.
