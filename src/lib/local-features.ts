/**
 * Local-only features — Sierra `.scid` bar import + auto-watcher, OBS video
 * commentary, and the local folder/file watchers — depend on the dev server
 * running on the user's own Windows machine (filesystem access + ffmpeg). They
 * cannot run on a cloud host (Vercel).
 *
 * This flag gates them so ONE codebase serves both deployments:
 *   • Local power-user build  → set NEXT_PUBLIC_ENABLE_LOCAL_FEATURES=true in
 *     .env.local  (everything works exactly as today)
 *   • Hosted/public build     → leave the var unset (local features hidden)
 *
 * NEXT_PUBLIC_* is inlined at build time, so this works in both client
 * components and server route handlers.
 */
export const LOCAL_FEATURES_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_LOCAL_FEATURES === 'true'
