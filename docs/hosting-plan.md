# Hosting Plan

Notes from a planning conversation on 2026-04-09. Not yet implemented — revisit
when V1 functionality is stable enough that daily iteration has slowed and the
app is worth sharing with a second user (initially: Bobby's wife).

## Goal

Host Capitaliano so that both Bobby and his wife can use it, each with their
own sessions, saved vocab, and transcripts. Should be reachable over the public
internet (no VPN dependency — Tailscale is ruled out because it conflicts with
commercial VPN use).

## Chosen approach: multi-tenant refactor + Fly.io + Cloudflare Access

After weighing "two isolated single-tenant instances" vs. "one multi-tenant
instance," multi-tenant won. The refactor is small (~150 lines across 3 files),
and the ongoing ops friction of running two instances forever (two deploys, two
sets of secrets, two URLs) is worse than a one-time afternoon of threading
`userId` through the code.

### Step 1 — Multi-tenant refactor

Scope every piece of per-user state by `userId`. Rough shape:

- **`lib/sessions.js`** — turn the module-level `activeSession` into a
  `Map<userId, session>`. Add a `userId` parameter to `create`, `get`, `end`,
  `update`, `remove`, `addLine`, `updateLine`, `getActive`,
  `setAudioStartedAt`. Scope file paths to `sessions/{userId}/...`. Scope the
  index file to `sessions/{userId}/index.json` (or add a `userId` field to
  entries and filter). ~40-60 lines of diff.
- **`lib/saved-vocab.js`** — same pattern. Per-user vocab file. ~20 lines.
- **`server.js`** — extract `userId` from the authenticated request (see Step 2),
  thread it through every `sessions.*` and `savedVocab.*` call. Tag each
  WebSocket connection with its owning `userId`. Replace `broadcast()` with
  `broadcastToUser(userId, data)` so one user doesn't see the other's
  transcription deltas. ~30-50 lines.
- **Tests** — update fixtures to pass a `userId`.

Cross-user isolation bugs to specifically guard against:
- `broadcast()` currently fans out to every WS client (`server.js:242-249`) —
  must be scoped.
- `activeSession` is a single global (`lib/sessions.js:8`) — must become a Map.
- `sessions/index.json` and `sessions/saved-vocab.json` are shared mutable
  files — must be per-user.

### Step 2 — Authentication: Cloudflare Access

**Do not build auth in the app.** Put Cloudflare Access in front of Fly.

- Free on Cloudflare Zero Trust (up to 50 users)
- Zero code changes — Cloudflare handles the entire login flow
- Email allow-list: add Bobby's email and his wife's email
- Login UX: user visits the site → enters email → receives 6-digit code →
  enters code → session cookie set for a configurable duration
- The app reads the authenticated email from the `Cf-Access-Authenticated-User-Email`
  header that Cloudflare injects on every request. That email becomes the
  `userId` used in Step 1.

**Requirements:**
- A domain (~$10/yr) pointed at Cloudflare
- Cloudflare origin configured to point at the Fly app
- Fly app configured to only accept traffic from Cloudflare IPs (so nobody
  can bypass Access by hitting `*.fly.dev` directly)

### Step 3 — Deployment: Fly.io

Fly.io runs containers as long-lived processes, which matches the app's needs
(persistent WebSocket, in-memory `activeSession`, filesystem writes for PCM).

**Why not Vercel/Netlify/Cloudflare Workers:** serverless platforms don't
support long-lived WebSockets, have ephemeral or read-only filesystems, and
assume stateless request handling. This app has a stateful resumable session,
streams audio over WS, and writes PCM to disk — none of which fit serverless.

**Dockerfile** (tiny — Fly can auto-generate this on `fly launch`):

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**First-time deploy sequence:**

```
fly launch                              # scaffolds Dockerfile + fly.toml
fly volumes create sessions --size 1    # 1GB persistent disk for sessions/
fly secrets set MISTRAL_API_KEY=xxx ANTHROPIC_API_KEY=yyy
fly deploy
```

Mount the volume at `/app/sessions` in `fly.toml` so session JSON and PCM
files survive restarts.

**Subsequent deploys:** just `fly deploy`. Or wire up the Fly GitHub Action
for git-push-to-deploy (equivalent to Vercel's model).

Expected cost: ~$2-5/month for the Fly VM + volume. Plus the domain (~$10/yr).
API costs (Mistral Realtime + Anthropic) are separate and scale with usage.

### Step 4 — Storage hygiene

PCM audio is the biggest ongoing cost — ~115 MB/hour per session. A nightly
cleanup job deletes `.pcm` files older than 30 days (keep the JSON
indefinitely). That keeps total storage under a few GB even with regular use.

Implementation: a small cron/systemd-timer in the container, or a simple
startup-time sweep in `server.js` that runs `unlink` on old PCM files.

## What we explicitly rejected and why

- **Two isolated Fly instances (one per user).** Ongoing ops friction of
  maintaining two deploys outweighs the one-time cost of the multi-tenant
  refactor. Only makes sense if you want to ship today and defer the refactor.
- **Vercel / Netlify / Cloudflare Workers.** No long-lived WebSockets, no
  persistent filesystem, stateless request model. Would require rewriting the
  backend against a completely different architecture (S3 for PCM, Ably/Pusher
  for WS, serverless functions for REST). Not worth it.
- **Tailscale + Raspberry Pi at home.** Conflicts with Bobby's commercial VPN
  usage. Tailscale and most commercial VPNs fight over the default route.
- **Building auth in the app (Basic Auth, magic links, Google OAuth).**
  Cloudflare Access is free, strictly stronger than anything we'd build
  ourselves, and keeps the app code free of auth logic entirely. Only worth
  building in-app auth if we ever outgrow Cloudflare Access's model.

## When to revisit

- V1 functionality is stable: the multi-tenant refactor is safe and the daily
  iteration rate has slowed enough that deploys don't interrupt live use.
- Bobby has used the app himself across several matches without finding new
  bugs ("I'd be embarrassed if it crashed, but not mortified").
- His wife has expressed actual interest in using it regularly.

## Open questions for when we revisit

- Should saved vocab be shared across users, or strictly per-user? (Default:
  per-user; shared is a future feature if wanted.)
- Should content types (`lib/content-types.js`) be per-user or global? (Likely
  global — they're small and static.)
- How long should a Cloudflare Access session last before re-auth? (Default
  24h is probably fine.)
- Do we want per-user cost caps on API usage, or trust the Mistral/Anthropic
  key-level billing limits?
