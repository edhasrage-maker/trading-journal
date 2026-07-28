-- Per-trade "highlight" flag — the P&L + score chip pinned above a trade's
-- entry arrow on the chart.
--
-- Stored on the trade rather than as a chart_annotation on purpose. An
-- annotation would freeze the numbers as text at the moment it was drawn, so
-- editing the trade afterwards (a corrected fill, a re-run analysis) would leave
-- a confidently wrong callout on the chart. A flag keeps the label DERIVED: the
-- chip always renders the trade's current P&L and its current execution score.
--
-- It also has to live in the database rather than localStorage because the whole
-- point is that someone else sees it — `get_shared_day` returns `to_jsonb(t)`,
-- so this column reaches the public /share/<token> chart with no further work.

alter table public.trades
  add column if not exists highlighted boolean not null default false;

comment on column public.trades.highlighted is
  'Show a P&L + execution-score chip above this trade on the chart, including on a shared link. Label is derived at render time, never frozen.';
