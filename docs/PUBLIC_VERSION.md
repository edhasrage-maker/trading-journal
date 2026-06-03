# Public-version feature inventory

Features specifically flagged as "save for the public release" — i.e., things
that aren't worth the build cost for a single trader's personal journal but
would matter for a wider audience.

Add to this list as we identify new ones during normal feature work.

## Auto-population of prep market context

- **Auto-populate prep ATR** from the most-recent 1-min bars (~30 min build).
  Removes the typo class. Personal use: prep ATR is mostly a fallback now
  that live ATR is computed per-trade, so the typo doesn't really hurt.
- **Auto-populate other market_context fields** (RVOL, ADR, IB size, gbx %
  of ADR) from bars at prep time (~2 hr build). Saves the trader from
  hand-entering numbers a public version would expect to be automatic.

## Post-Exit Continuation: configurable windows

- Current implementation uses a **30-minute** post-exit window only.
- Public version should expose **window selection** (30m / 1h / 2h / 4h or
  user-chosen) so traders with different holding styles get a meaningful
  read. Toggle could live on the dashboard or per-chart settings.

## Add new entries here as they come up

