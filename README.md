# HLS Playlist Archives at the edge

Playlist Archives (`EXT-X-ARCHIVE`) is an [early proposal](https://mailarchive.ietf.org/arch/msg/hls-interest/6gJ3npq1b1bwYtpqIZWbaVvOIaE/) for HLS. A live
playlist with a long rewind window lists only its last few minutes of segments, and points at archives for the rest:
`.m3u8a` files that a player loads only when playback reaches them, and never has to refresh.

This is an unofficial implementation, for trying the idea with live streams that exist today:

- **An edge function** that adds archives to any live stream from AWS MediaPackage or Unified Origin. It builds them
  from the origin's own time-shift requests, and keeps no state.
- **A player** (`index.html`): hls.js, built from a branch with archive support, and a bar under the video that shows where
  each archive sits on the timeline and which ones hls.js has loaded.
- **An edge inspector** (`inspect.html`): see how the edge works. Load a live stream and click through its playlists
  and archives, one request at a time, with what the edge fetched to answer each one.

```sh
npm start    # both demos at http://localhost:8787
```

Both run the edge function in the page, so they work with any of those streams that has a DVR window and allows
cross-origin requests. They start with the [Unified Streaming demo channel](https://demo.unified-streaming.com/k8s/vod2live/stable/).
With a two-hour window, each refresh of its playlist is about 33 KB, where a playlist with the whole window would be
about 310 KB.

The demos assume that a URL with `.arch.` in it already comes from a deployed edge, so they read it directly and leave
the edge in the page out of it. `?src=<url>` opens either demo on a stream of your choosing, for sending someone a link to yours.

## What the player gets

`index.m3u8` becomes `index.arch.m3u8` (a two-hour window) or `index.arch.6h.m3u8`. The multivariant playlist points at
the media playlists' `.arch` twins, and each media playlist starts with its archives:

```
#EXTM3U
#EXT-X-VERSION:5
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:10778190
#EXT-X-DISCONTINUITY-SEQUENCE:0
#EXT-X-ARCHIVE:FIRST-MSN=10774756,DURATION=515.518,START-PROGRAM-DATE="2026-10-10T17:34:13.215Z",URI="unified-learning-audio_eng=128000-video=400000.arch.10774712-10775024.1791653567-1791654167.m3u8a"
#EXT-X-ARCHIVE:FIRST-MSN=10775025,DURATION=601.300,START-PROGRAM-DATE="2026-10-10T17:42:48.733Z",URI="unified-learning-audio_eng=128000-video=400000.arch.10775025-10775337.1791654167-1791654769.m3u8a"
…
#EXT-X-PROGRAM-DATE-TIME:2026-10-10T19:23:58.523Z
#EXTINF:1.92, no desc
unified-learning-audio_eng=128000-video=400000-10778190.ts
…
```

An archive is the sequence tags, then segments:

```
#EXT-X-MEDIA-SEQUENCE:10778155
#EXT-X-DISCONTINUITY-SEQUENCE:0
#EXT-X-PROGRAM-DATE-TIME:2026-10-10T19:22:51.323333Z
#EXTINF:1.92, no desc
unified-learning-audio_eng=128000-video=400000-10778155.ts
…
```

## How the edge does it

- An archive is a run of N Media Sequence Numbers that starts at a multiple of N, with N set to about ten minutes of
  segments. Its name follows from its first number, so every edge, at any time, gives it the same name.
- Its segments come from the origin's time-shift request for that range: `start` and `end` on MediaPackage, `vbegin`
  and `vend` on Unified Origin. It is cached for a day.
- A table of every archive's times and durations is built once per archive and cached. It makes each `DURATION` and
  `START-PROGRAM-DATE` exact.
- The live playlist keeps one archive's worth of segments plus a few, so it overlaps the newest archive, and segments
  leave it one at a time once archived. An archive's `DURATION` counts only its segments that have left the playlist,
  so a new archive starts at 0 seconds and grows, and the archives plus the playlist add up to the window. This is how
  the examples work in Apple's [talk at HLS Interest Day](https://www.youtube.com/watch?v=AvwdwAbQ51s&t=6060s) on 7 October 2026.
- Archives can't carry `EXT-X-DATERANGE`, so the media playlist keeps the date ranges of the whole window.

Every generated URL has `.arch.` in it and sits next to the origin's playlist, so segment URIs resolve as before.

## Running it

```sh
npm start                                           # the demos
npm test                                            # unit tests
node scripts/check.mjs <url> [--window 2h]          # checks a live stream's playlists and archives; only reads
```

Node 22 or later. There are no dependencies. The deploy scripts also need bash, the AWS CLI, `jq` and `zip`.

### On CloudFront

`src/handler.mjs` is a Lambda@Edge origin-request function for one new cache behavior, `*.arch.*`, on the distribution
already in front of the origin. It reads the origin through that distribution, so it shares its access and its cache.

```sh
deploy/deploy-function.sh                                   # creates the function in us-east-1, prints a version ARN
deploy/attach-behavior.sh <distribution-id> <version-arn>   # adds the *.arch.* behavior
```

The origin has to write `EXT-X-PROGRAM-DATE-TIME`, and the `*.m3u8` behavior has to pass the time-shift query strings
through to the origin and include them in its cache key. A window reaches back as far as the origin keeps segments, up to 24 hours by default. Settings are in
`src/config.mjs`, and removing the behavior turns it all off.

## hls.js

`vendor/hls.js/hls.min.mjs` is hls.js built from the
[`feature/playlist-archives`](https://github.com/pbs/hls.js/tree/feature/playlist-archives) branch, with its source map.
It loads an archive when playback or a seek reaches it, places it on the timeline by Media Sequence Number, and keeps
only the archives it needs. hls.js is under the Apache License 2.0 (`vendor/hls.js/LICENSE`); the rest of this repo is
MIT (`LICENSE`).

## Where the proposal leaves room

These are the choices made here, and things worth asking about.

- The written proposal defines `DURATION` as the sum of segment durations from `FIRST-MSN` to the end of the archive.
  This edge counts only the segments that have left the playlist, as the examples in the talk do.
- Archives have no `#EXTM3U`, as in the proposal's example. They are served as `application/vnd.apple.mpegurl`.
- The proposal says a date or timestamp correction should start a new archive. Archives here are fixed ranges of
  numbers, so a correction can land inside one.
- Each rendition reaches back the same length of time from its own live edge. Right after an archive closes, one
  rendition can list it a few seconds before another does.
- Unified Virtual Channel writes no `EXT-X-DISCONTINUITY-SEQUENCE`. Its archives say `:0` and keep an
  `EXT-X-DISCONTINUITY` on their first segment when it follows a break.
- A player asks for archives with the `.arch` URL. Nothing in a request says that a client understands them.
