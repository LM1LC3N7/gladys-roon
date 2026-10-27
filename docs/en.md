# Roon zones (unofficial)

Unofficial connector, not affiliated with Roon Labs. It talks to your **Roon
Core** (Roon Server, Nucleus, ROCK, or the Roon app acting as Core) on the
local network, through the official Roon extension API: no account, no cloud.

> Built from the Roon API documentation: it was **never tested with a real Roon Core**.
> Reports are welcome (GitHub issues of `LM1LC3N7/gladys-roon`).

Requires Gladys 5.3.0 or later (the Music widget).

## What you get

One Gladys device per **Roon output** (a room, a speaker, a DAC), with:

- playback: play, pause, stop (the Music widget), previous, next;
- the track playing: title, artist, album, artwork, duration and position;
- shuffle and repeat (off, all, one);
- volume (0-100 % of the range of the output) and mute, when Roon can set
  the volume of the output (not for a fixed volume nor for +/- only
  controls);
- the name of the zone the output plays in (e.g. "Living room + Kitchen"
  when grouped).

Two scene actions: **group two outputs** (the zone keeps the queue of the
first one) and **take an output out of its group**.

## Setup

1. Type the **address** of the Roon Core (give it a fixed address in your
   router), or click **Find the Roon Core**: Gladys asks the local network,
   and when exactly one Core answers and no address is typed, its address is
   saved. The **port** is 9330 for Roon 2 (9100 for older versions).
2. In Roon, open **Settings > Extensions** and click **Enable** next to
   **Gladys Assistant**. Until then the status says it is waiting for the
   authorization.
3. Open the **Discovery** tab and add the outputs you want.

The authorization the Core gives is kept in the `/data` folder of the
integration (never in the logs, never shown). **Forget the Roon
authorization** deletes it: the extension then has to be enabled again in
Roon.

## Volume cap

**Volume cap (%)**, 50 by default: the highest volume Gladys may set, in
percent of the range of each output (100: no cap). A higher volume asked by a
scene or the dashboard is set to the cap, rounded down to a step of the
output, and never above the limits set in Roon. Unmuting first brings the
volume back under the cap when it is above (and is refused when the volume of
the output is unknown, while a cap applies). The volume changed in Roon itself
is not touched.

## Commands and their answers

A command is a success when the Core accepted it **and** the state Roon sends
back shows it (play, pause, stop, volume, mute, shuffle, repeat, grouping).
Seek, previous and next succeed when the Core accepts them. Otherwise the
answer says what happened: "nothing sent", "sent, without an answer (not
confirmed)", "accepted, not yet seen applied (not confirmed)" or "refused by
the Roon Core".

**Pause, stop, mute and a lower volume are not held by the volume cap.** They
are refused only when nothing can receive them:

- the Roon Core is not connected (or not yet authorized);
- the output is not in Roon right now (off, renamed or removed), or two
  outputs have the same name;
- the value is invalid;
- for mute and volume: the output has no volume Gladys can set;
- more than 256 requests are already waiting for the Core (a Core that stopped
  answering; other commands are held from 64 on).

A zone that cannot pause (a live radio) is stopped instead. An unmute that
waits for its volume step is not sent when another command for the same
output was clicked meanwhile (a mute clicked after it is never overtaken).

## Good to know

- **Identity**: an output is identified by its name in Roon, as Home Assistant
  does (Roon may change its internal ids). Renaming an output in Roon gives a
  new device in Gladys; two outputs with the same name are left out.
- The states come live from the Core (subscription), nothing is polled. After
  a loss of the Core, nothing is published until the Core is back; the badge
  of the devices shows "unreachable" meanwhile. The connection is tried again
  after 5 s, then 10 s, up to every 2 minutes.
- The artwork is fetched from the Core (400 px, at most 300 KB) when Gladys
  shows it.
- No playlists, library or radio browsing yet (see the TODO of the
  repository).
