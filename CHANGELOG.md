# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Roon outputs as Gladys music players through the official Roon extension
  API (local WebSocket of the Roon Core, extension "Gladys (community)" enabled
  in Roon, Settings > Extensions): playback state (play, pause, stop),
  previous, next, title, artist, album, artwork, duration, position (seek),
  shuffle, repeat, volume and mute, the name of the zone; live by
  subscription.
- Volume cap (50 % by default), unmuting brought under the cap first; pause,
  stop, mute and a lower volume never held by it.
- Scene actions "group two outputs" and "take an output out of its group".
- Buttons "Find the Roon Core" (SOOD through Gladys), "Show the connection",
  "Forget the Roon authorization".

[Unreleased]: https://github.com/LM1LC3N7/gladys-roon/commits/main
