---
name: verify
description: Build, launch, and drive the sparrow app to verify a change end-to-end (dev docker stack + Chrome DevTools MCP).
---

# Verifying sparrow changes at the real surface

## Build + launch (dev stack)

```sh
# from the repo root; set BASE_URL to how other devices reach this box
BASE_URL=http://<lan-or-vpn-ip>:8722 docker compose up -d --build
curl -s http://localhost:8722/healthz   # {"ok":true,...}
```

This is also the standing "dev site always up" rebuild — leave it running.
`AUTH_MODE=none` on this stack; server-templated URLs use BASE_URL while
browser-computed ones use window.location.origin — both are correct.

## Drive the web UI

Use the Chrome DevTools MCP tools against http://localhost:8722. Key trick:
`new_page` with a distinct `isolatedContext` per persona (e.g. `creator`,
`invitee`) — mode `none` keeps room sessions in localStorage, so isolated
contexts give you independent users, letting you exercise multi-member flows
(invites, SSE fanout like live renames / agent.joined) in one browser.

Flows worth driving: create room (auto-joins + opens Invite modal) →
copy join URL → open it in a second context (join page context/toggle) →
rename via ✎ Room settings and watch the other context update live.

## API surface

Raw curl against `http://localhost:8722/api/v1/...`; agent onboarding doc:
`curl http://localhost:8722/join?code=X` (non-HTML Accept → markdown).

## e2e scenarios (separate containers, not the dev stack)

```sh
scenarios/run-all.sh    # or a single scenarios/NNN-*/run.sh
```
