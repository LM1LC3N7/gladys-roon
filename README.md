# gladys-roon

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Roon**, not affiliated with Roon Labs: the outputs of your Roon Core as
Gladys music players (play, pause, stop, previous, next, volume, mute,
shuffle, repeat, now playing with artwork for the Music widget of Gladys 5.3),
and grouping by scene actions. It talks to the Roon Core on the local network
through the official Roon extension API (WebSocket, MOO/1): no account, no
cloud.

Built from the Roon API documentation, it was **never tested with a real Roon
Core**: reports welcome in the issues.

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- Project rules, architecture and decisions: [CLAUDE.md](CLAUDE.md),
  [TODO.md](TODO.md)
- Credits: the protocol is ported from
  [node-roon-api](https://github.com/RoonLabs/node-roon-api) (Apache-2.0,
  Roon Labs), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm test            # node --test (fake Gladys of the SDK, fake Roon Core over loopback WebSocket)
npm run lint
npm run format:check
npm run audit
```

Licensed under the Apache License 2.0.
