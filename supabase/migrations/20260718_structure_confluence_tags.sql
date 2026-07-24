-- Follow/Fade LTF (5m) structure confluence tags (Pt 11).
--
-- Backs the DETERMINISTIC suggestion in /api/trades/suggest-tags: a trade's
-- stored `structure_5m_regime` (written at SC-log import) + its direction run
-- through market-structure.ts::followFade() to yield follow | fade exactly — no
-- model guess. The route is constrained to labels that exist in trade_tags, so
-- until this runs the suggestion is silently skipped (clean degradation).
--
-- ⚠ The two databases have DIFFERENT trade_tags shapes — run the matching
-- section only:
--   • personal DB : no user_id, unique (category, label)
--   • cloud DB    : per-user user_id, unique (user_id, category, label)

-- ── PERSONAL DB ──────────────────────────────────────────────────────────────
insert into trade_tags (category, label, sort_order, description)
values
  ('confluences', 'Follow LTF structure', 11,
   'Entry aligned WITH the 5m pivot structure (long in a bull regime / short in a bear regime).'),
  ('confluences', 'Fade LTF structure', 12,
   'Entry AGAINST the 5m pivot structure (long in a bear regime / short in a bull regime).')
on conflict (category, label) do nothing;

-- ── CLOUD / PUBLIC DB ────────────────────────────────────────────────────────
-- Backfill every EXISTING user that already has a tag library, then teach the
-- new-signup seeder so future accounts get them too.
--
-- insert into public.trade_tags (user_id, category, label, sort_order, description)
-- select u.id, v.category, v.label, v.sort_order, v.description
-- from auth.users u
-- cross join (values
--   ('confluences', 'Follow LTF structure', 11,
--    'Entry aligned WITH the 5m pivot structure (long in a bull regime / short in a bear regime).'),
--   ('confluences', 'Fade LTF structure', 12,
--    'Entry AGAINST the 5m pivot structure (long in a bear regime / short in a bull regime).')
-- ) as v(category, label, sort_order, description)
-- where exists (select 1 from public.trade_tags t where t.user_id = u.id)
-- on conflict (user_id, category, label) do nothing;
--
-- Then add these two lines to the Confluences block of
-- public.seed_default_trade_tags() in supabase/schema.public.sql so new signups
-- are seeded with them:
--   (p_user_id, 'confluences', 'Follow LTF structure', 11),
--   (p_user_id, 'confluences', 'Fade LTF structure', 12),
