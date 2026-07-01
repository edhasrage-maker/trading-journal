import { NextResponse } from 'next/server'
import { LOCAL_FEATURES_ENABLED } from './local-features'

/**
 * Server-only guard for API routes that depend on local-machine resources —
 * Sierra `.scid` files, the OBS recordings directory, ffmpeg. Those resources
 * don't exist on a cloud host, so in the cloud build (NEXT_PUBLIC_ENABLE_LOCAL_
 * FEATURES unset) these routes return 404.
 *
 * This is defense-in-depth: the UI that calls them (BarWatcher, SCFolderWatcher,
 * the SC-log import button, RecordingCommentary, the Bar Data / SC Archives
 * settings pages) is already hidden in the cloud build, so nothing reaches these
 * routes through the app. The guard just makes a direct URL hit fail cleanly
 * instead of throwing a filesystem error.
 *
 * Usage — first line of the handler:
 *   const blocked = blockIfCloud(); if (blocked) return blocked
 *
 * NB: this module imports `next/server`, so it is server-only. Do NOT import it
 * from client components — import the plain `LOCAL_FEATURES_ENABLED` flag from
 * `./local-features` instead.
 */
export function blockIfCloud(): NextResponse | null {
  if (LOCAL_FEATURES_ENABLED) return null
  return NextResponse.json(
    { error: 'This endpoint is only available in the local desktop build.' },
    { status: 404 },
  )
}
