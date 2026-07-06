# OBS frame commentary → public (cloud) build

**Status:** plan / not started. Local build already does tiled frame commentary
(`src/lib/video-frames.ts` `extractFrameWithTiles`, `src/app/api/video/commentary`).
This doc covers turning it into a hosted differentiator.

## The blocker

The local build reads the `.mp4` straight off `OBS_RECORDINGS_DIR` and runs
ffmpeg on the user's own machine. On the hosted build:
- Vercel can't read the user's disk, and has no ffmpeg.
- A session recording is multi-GB (7 GB for ~94 min at CQP) — uploading the
  whole file per session is a non-starter.

So the frame extraction must happen **where the file already is: the browser.**

## Chosen approach — client-side extraction, upload only tiles

The heavy video never leaves the machine. The browser extracts just the needed
frames, tiles them, and uploads only the small tile JPEGs (~100 KB each) for the
AI call.

### Flow
1. **Pick file** — user selects the local recording via `<input type=file>`
   (no server upload). Same recording they record with OBS.
2. **Compute offsets** — reuse today's math: `offset = entry_time −
   recording_start`. Recording start comes from the filename pattern (the
   `probeVideo` logic), which the client can parse from `file.name`; fall back to
   `file.lastModified − duration`.
3. **Decode frames** — **WebCodecs `VideoDecoder`** (native, fast, Chrome/Edge)
   seeks and decodes the target frames. Fallback: `ffmpeg.wasm` (slower, ~30 MB
   wasm) for browsers without WebCodecs. Demux with `mp4box.js` to feed encoded
   chunks to the decoder.
4. **Tile** — draw each decoded `VideoFrame` to an `OffscreenCanvas`, slice into
   the same `cols×rows` grid + overview, `canvas.convertToBlob({type:'image/jpeg',
   quality:0.9})`. This mirrors `extractFrameWithTiles` exactly, just in canvas.
5. **Upload + analyze** — POST the tile blobs + trade metadata to a new route
   variant (`/api/video/commentary-upload`) that accepts uploaded images instead
   of reading local files, then runs the *same* Anthropic call and persistence.

### Server changes
- New route `commentary-upload` (multipart or base64 JSON): takes
  `{ trades, images: [{trade_id, kind: 'overview'|'tile', label, data}] }`,
  builds the same `blocks[]` + prompt as `commentary/route.ts`, same schema.
- **Reuse** the prompt/schema/persistence from the existing route — factor the
  shared bits into `src/lib/commentary-core.ts` so local + upload paths share one
  implementation and don't drift.
- **AI caps**: gate with the existing per-user `ai_usage` / `consume_ai_usage`
  infra (like coach-score). Each run is N images → count it against a daily cap.
- **No storage of the video**; optionally store the tile JPEGs the same way the
  local path stores the auto-screenshot (private bucket + signed URL).

### Cost / limits
- Entry = overview + `cols*rows` tiles. Keep the image-budget cap. Consider
  2×2 on the hosted build (5 imgs/entry) to cut vision-token cost vs 3×2 local.
- WebCodecs decode of a few frames is sub-second; ffmpeg.wasm fallback is the
  slow path — show progress.

## Why not the alternatives
- **Upload full file → server ffmpeg**: needs a persistent worker (not
  serverless) + multi-GB/session storage + slow uploads. Heavy, expensive.
- **Local companion agent**: works, but adds an install step and support burden.

## Open questions
- WebCodecs coverage on the users you target (desktop Chrome/Edge = yes; Safari
  partial). ffmpeg.wasm fallback closes the gap at a speed cost.
- Replay/anchor: same caveat as today — offset math assumes recording wall-clock
  == on-screen market clock at 1×.
- Whether to also do the Whisper/audio track (narration intent) as the sibling
  differentiator — higher signal than frames alone.

## Related
- Ties to the "AI model tiering + browser recap" memory (Phase 2 = client-side
  extraction).
- Local implementation to mirror: `extractFrameWithTiles` in
  `src/lib/video-frames.ts`; prompt/schema in
  `src/app/api/video/commentary/route.ts`.
