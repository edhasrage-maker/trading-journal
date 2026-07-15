# Brand fonts (build-time only)

Static Archivo weights used by `scripts/build-brand-assets.mjs` to OUTLINE the
"TapeScore" wordmark (Tape = Light, Score = Bold) into vector paths. Archivo is
the app's display font, so the logo matches the UI.

- `Archivo-Light.ttf` — wordmark "Tape"
- `Archivo-Bold.ttf` — wordmark "Score"

Source: Omnibus-Type/Archivo (`fonts/ttf/`), SIL Open Font License 1.1.
These files are NOT shipped to the browser or bundled into the app — they exist
only so the brand generator is reproducible offline. Regenerate assets with:

```
node scripts/build-brand-assets.mjs
```
