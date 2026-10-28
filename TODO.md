# TODO — Roon v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Status

- [x] **Milestone 1 — core** (2026-10-27): one session with the Roon Core of
      the configuration (address typed or found by SOOD through the Gladys
      core), registration as the extension "Gladys (community)" (token kept in
      /data by core id), zones and outputs by subscription; one device per
      output with the music features of Gladys 5.3 (playback state, play,
      pause, previous, next, title, artist, album, artwork, duration,
      position, shuffle, repeat, volume, mute) and the zone name; commands
      confirmed by the picture; volume cap; scene actions group / ungroup;
      buttons find, show, forget. Tested against a fake Core over a real
      loopback WebSocket, the SDK fake Gladys, a virtual clock and the real
      clock x20. No real Core.
- [x] Review r3 (2026-10-28): APPROUVÉ, no blocker.
- [ ] Next patch — review r3 leftovers: `tokenUnsaved` stays true after a
      failed write followed by a successful `record()`; `publishTransports`
      may record an id (harmless); say in the docs that any Discovery accepts
      a name swap; `E.*` messages are English only.
- [ ] **Milestone 2 — a real Core**: a tester's Roon Core (see "To check on a
      real Core").
- [ ] **Milestone 3 — more**:
  - the queue (`subscribe_queue`, `play_from_here`) as `music.queue`;
  - browse and search (`com.roonlabs.browse:1`) as `music.browse` /
    `music.search`, `music.play-media`;
  - standby / convenience switch of the source controls (an output in
    standby), `transfer_zone`;
  - `keywords` and `countries` of the manifest (Gladys 5.3.0 accepts them).

## To check on a real Core

- The register flow: does the Core answer `Registered` as CONTINUE or
  COMPLETE; what it sends when the extension is disabled (the session ends on
  any later answer of the register request that is not `Registered`).
- The port 9330 of Roon 2 (9100 before); SOOD answers relayed by the Gladys
  core (`udp-active-broadcast` on 9003): `http_port` present, the source
  address the Core's.
- Volume changes arrive by `zones_changed` and / or `outputs_changed` (both are
  read, the last message wins).
- `soft_limit` / `hard_limit_max` of an output; the `db` range mapping of a
  real DAC (linear in dB, as Home Assistant).
- `get_image` with `scale: fit`, 400 x 400, `image/jpeg`: size under 300 KB.
- Output display names: unique per Core as users name them; what happens to
  the name of an output of a grouped zone.
- `is_pause_allowed: false` on a live radio (pause sent as stop).
- A MOO frame whose body is longer than its `Content-Length`: node-roon-api
  tolerates the extra bytes, `src/roon/moo.js` refuses the frame (the session
  would end as "not a Roon Core" in a loop). Relax if a real Core does it.
- `confirm` succeeds at once when the state asked is already there, and says
  "not yet seen applied" for a volume the Core trims to a limit (documented).

## Decisions

- **Version 0.1.0** set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (the first patch release gives 0.1.1).
- **SDK 0.16.0** (latest on npm, 2026-10-27), for the `music` field and
  `publishNowPlaying`. **`gladys_version` `>=5.3.0`**, not the `>=5.1.0` of
  the other modules: the store refuses a manifest declaring `music` with a
  lower minimum (5.3.0 is the first release accepting it, published
  2026-10-25), and the Music widget is the point of the module.
- **Port of node-roon-api, not a dependency**: the library (Apache-2.0, Roon
  Labs, commit 055dae6 of 2026-02-03) is not on npm; a git dependency pinned
  by commit would need git in the Alpine image, pulls `node-uuid`
  (deprecated), writes `config.json` in the working directory (read-only
  rootfs) and logs every MOO body with `console.log`, the register body with
  its token included. The protocol is small: `src/roon/moo.js` (format),
  `src/roon/session.js` (connection), `src/roon/sood.js` (discovery message),
  ~500 lines, hardened (bounded headers and frames, `ws` maxPayload 1 MiB,
  strict lengths). `ws` (MIT), the library's own transport, is the only other
  runtime dependency.
- **Extension id `io.github.lm1lc3n7.gladys-roon`** (review r1, B1): a
  reverse DNS name the author controls, never `com.gladysassistant` (the
  domain of the Gladys project, which would share the tokens with an official
  extension one day) nor the id of another platform (Home Assistant uses
  `home_assistant`; lot 16 lesson, laundrify). Display name "Gladys
  (community)", publisher "LM1LC3N7 (Gladys community integration, not by
  Gladys Assistant)", status "Connected to Gladys (community integration)",
  e-mail the public GitHub noreply address (Roon Labs cannot write to it; the
  website is the repository). The Core keys the authorization on the id:
  **never change it after the first release**.
- **One device per output, identified by its display name**
  (`output:<16 hex of SHA-256(name)>`), as Home Assistant (which saw output
  and zone ids change). Renaming an output gives a new device; two outputs of
  one name are left out (not listed, not commanded, nothing published). The
  output id is read again from the live picture before every command.
- **Swapped names** (review r1, M1): `/data` keeps the output id last seen
  for each name; when the id of a name is alive under another name, the
  device publishes nothing, silencing commands go to the recorded output (its
  room), the others are refused, until a Discovery (scan) takes the names as
  they are. Homonyms (I2): pause, stop, mute and a lower volume go to all of
  them, the rest is refused.
- **Commands straight to the Core**: MOO is multiplexed (Request-Id), the Core
  a server; commands go in click order on one socket, without a queue, so a
  pause never waits behind another request. The fiche's "one request at a
  time" is for single-client devices.
- **Success = Core Success + picture showing it** (2 s at most, 3.5 s budget in
  all; Gladys cuts at 5 s); seek, previous and next have no state to compare.
  "Sent, without an answer" when the request left without answer, "nothing
  sent" when it never left.
- **Volume cap** 50 by default (1-100, a wrong value gives 1), in percent of
  the range of the output, rounded down to a step, never above `max`,
  `hard_limit_max`, `soft_limit`. Unmuting lowers to the cap first (refused
  when the volume is unknown and a cap applies), and the unmute is not sent if
  another command for the output was clicked meanwhile. Pause, stop, mute and
  a lower volume are never held by the cap.
- **Pause of a zone that cannot pause** (`is_pause_allowed: false`, a live
  radio): stop.
- **States**: published only from a live, complete picture (both
  subscriptions answered); after a loss, nothing until the Core is back;
  `connected` of Gladys forgets the snapshots and republishes from the
  picture. An output Roon removed gets IDLE and cleared texts (a fact from
  Roon). Positions are samples (the SDK republishes a position only on a
  seek). 300 states/min: the flush stops at 280 in the last minute and waits.
- **Token**: in `/data/roon-state.json` (mode 600) by core id, at most 8
  cores, sent at register to whatever answers at the typed address with that
  core id (plain `ws://`: in clear text on the LAN, inherent to the Roon API,
  said in the docs); never in logs, statuses, errors.
  An unreadable file is not empty: nothing is sent to the Core (it would
  register as a new extension) and the file is never overwritten, until
  "Forget the Roon authorization".
- **Discovery**: SOOD (UDP 9003) through `scanNetwork('udp-active-broadcast')`
  on a click only; `_replyaddr` of an answer is never followed; one Core found
  and no address typed: saved with `setConfig` and applied.
- **Grouping** by scene actions only (Gladys has no group feature):
  `group_outputs` when Roon lists the member in `can_group_with_output_ids`,
  `ungroup_outputs`; confirmed by the zones. The zone name is a read-only text
  feature.
- **Command errors in English only** (`E` in `src/i18n.js`): Gladys shows the
  message of a failed acknowledgement as is; statuses and buttons are en/fr.
- **No `poll_frequency`**: the Core pushes everything.
- Container: read-only rootfs, `/data` for the tokens and the output id of each name, bridge network.
