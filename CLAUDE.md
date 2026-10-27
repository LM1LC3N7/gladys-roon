# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16) and to a
**Roon Core** through the official Roon extension API (WebSocket
`ws://<core>:9330/api`, MOO/1 messages), ported from node-roon-api
(Apache-2.0). Runtime dependencies: the SDK and `ws`. One device per Roon
output, music features of Gladys 5.3. Local only. Unofficial: not affiliated
with Roon Labs.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
npm run lint
npm run format:check
npm run audit
npm run cover                             # regenerates cover.png
node ~/code/ref/integration-store/src/validate-cli.js . --skip-image-check
```

## Architecture

```
index.js                SDK bootstrap only
src/handlers.js         every SDK handler -> the app (shared with the tests)
src/app.js              RoonApp: lifecycle, session, publication, commands,
                        scene actions, buttons, artwork
src/roon/session.js     one WebSocket session: info, register, subscriptions,
                        ping/status services, keepalive, requests
src/roon/moo.js         MOO/1 encode / parse (pure, bounded)
src/roon/model.js       zones and outputs -> values (pure), RoonState
src/roon/sood.js        SOOD discovery message (pure)
src/devices.js          the output device, its id, its features (pure)
src/store.js            /data: the tokens by core id, the output id by name
src/config.js           config_schema normalized
src/constants.js        extension id, timings, limits, keys
src/i18n.js             runtime texts (en/fr)
test/helpers/fakeCore.js  a fake Roon Core on a loopback WebSocket
```

## Rules

- **Keys are forever**: the extension id (`EXTENSION` in
  `src/constants.js`: the Core keys the authorization on it), the manifest
  keys, the feature keys (`FEATURE`), the device id shape
  `output:<16 hex of SHA-256(display name)>`.
- **The token never leaves /data and the Core**: never logged, never in a
  status, an error or a test output. Log error names and codes, never a body.
- **States only from the live picture** of the current session; nothing
  stale republished.
- **Pause, stop, mute, a lower volume** are never held by the volume cap nor
  by anything but "nothing can receive them" (see docs, "Commands").
- **Volume** always under the cap and the limits of the output.
- **Read-only rootfs**: write only `/data`.
- **Versions belong to the Release workflow**; changelog under
  `## [Unreleased]`.
- **User-facing text** bilingual (`docs/en.md`, `docs/fr.md`, manifest,
  `src/i18n.js`); a secret is never described as ciphered (test/encoding.test.js).
- **Tests never touch the network** beyond loopback (the fake Core, the
  servers of `~/code/ref/gladys-testkit`).
- **Built blind**: no Core was at hand; `TODO.md` lists what to confirm.
