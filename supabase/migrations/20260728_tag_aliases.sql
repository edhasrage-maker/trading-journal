-- 2026-07-28 — Add `aliases` to trade_tags, and seed the owner's library.
--
-- WHY. A tag label is a phrase; notes are prose. src/lib/suggest-tags.ts
-- requires EVERY significant word of the label to appear, so "VWAP Hold/Bounce"
-- needs "vwap" AND ("hold" OR "bounce") and a note reading "the increased
-- volatility at VWAP" auto-tags nothing. Real misses from live notes:
--   "wrong size on"                      -> Oversized
--   "so entered BOC"                     -> Break of Candle
--   "HUGE sellers on the DBP"            -> Large Delta on DBP
--   "the increased volatility at VWAP"   -> VWAP Hold/Bounce
-- No significant word overlaps in any of them, so no amount of stemming bridges
-- it — only the trader's own vocabulary can.
--
-- A SEPARATE COLUMN, not folded into `description`: that field is injected
-- verbatim into the /api/predict-day-type prompt as a per-label rubric, and
-- matcher keywords do not belong inside an LLM instruction.
--
-- Run on BOTH databases (local + public/prod). This file is written to be
-- correct on both: the public trade_tags is per-user, the local single-tenant
-- one has no user_id column at all, so the seed is issued as dynamic SQL and
-- only adds the user_id predicate where that column actually exists. A plain
-- `WHERE user_id = ...` guarded by an IF would still fail on the local DB,
-- because PL/pgSQL plans the statement whether or not the branch is taken.

ALTER TABLE trade_tags
  ADD COLUMN IF NOT EXISTS aliases text[];

COMMENT ON COLUMN trade_tags.aliases IS
  'Alternative phrasings that auto-select this tag from notes. Each alias is matched with the same all-significant-words rule as the label, so a multi-word alias stays specific while a single-word alias is a deliberate broad catch. Editable in Settings > Tags; confirming an AI-suggested tag appends here.';

-- ---------------------------------------------------------------------------
-- Seed.
--
-- Deliberately CONSERVATIVE: every alias is multi-word or an unambiguous
-- abbreviation, so it stays specific. Existing aliases are NOT overwritten --
-- the seed only fills rows where the column is still null, so re-running is
-- safe and hand-edits survive.
--
-- One judgement call worth knowing about: bare "vwap" is NOT seeded. It would
-- fire VWAP Hold/Bounce on "broke through VWAP", which is the opposite trade.
-- "at vwap" and "vwap reclaim" are seeded instead. Widen it yourself in
-- Settings > Tags if you want the broad catch.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  owner_id uuid;
  has_user_id boolean;
  scope text := '';
  s record;
  n integer;
  total integer := 0;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'trade_tags' AND column_name = 'user_id'
  ) INTO has_user_id;

  IF has_user_id THEN
    SELECT id INTO owner_id FROM auth.users WHERE email = 'edhasrage@gmail.com';
    IF owner_id IS NULL THEN
      RAISE NOTICE 'owner not found — column added, seed skipped';
      RETURN;
    END IF;
    scope := format('user_id = %L AND ', owner_id);
  ELSE
    RAISE NOTICE 'no user_id column — seeding all rows (single-tenant local DB)';
  END IF;

  FOR s IN
    SELECT * FROM (VALUES
      -- confluences
      ('confluences', 'VWAP Hold/Bounce',
       ARRAY['at vwap','vwap reclaim','vwap bounce','reclaimed vwap','vwap rejection']),
      ('confluences', 'Large Delta on DBP',
       ARRAY['huge delta','big delta','large delta','huge sellers','huge buyers','delta on dbp','vps and delta','stacked delta']),
      ('confluences', '2nd Attempt',
       ARRAY['second attempt','2nd try','2nd time','second time','tried again','entered again']),
      ('confluences', '3rd Attempt',
       ARRAY['third attempt','3rd try','3rd time','third time']),
      ('confluences', 'Added to Position',
       ARRAY['added to position','added size','scaled in']),
      -- entry_model
      ('entry_model', 'Break of Candle',
       ARRAY['boc','break of candle','entered boc']),
      ('entry_model', 'Break of Clusters/Bubbles',
       ARRAY['bubbles','clusters']),
      ('entry_model', 'Waited for Heiken-Ashi to Flip',
       ARRAY['ha flip','heiken ashi flip','waited for the flip']),
      -- mistakes
      -- '!oversized ib' is an EXCLUSION (leading !). Real note: "Took this bc of
      -- oversized IB way above avg" describes a WIDE INITIAL BALANCE, not the
      -- position size, and was tagging the mistake Oversized. A wrong tag is
      -- worse than a missing one here because these feed Entry scoring.
      ('mistakes', 'Oversized',
       ARRAY['wrong size','too big','sized up','oversize','too much size','!oversized ib','!ib was oversized']),
      ('mistakes', 'FOMO',
       ARRAY['fomo','fomod','jumped in']),
      ('mistakes', 'Chased',
       ARRAY['chased','chasing']),
      ('mistakes', 'Too Early',
       ARRAY['too early','early trigger','before the trigger']),
      ('mistakes', 'No Confirmation',
       ARRAY['no confirmation','without confirmation','no confirm']),
      ('mistakes', 'Revenge Trading',
       ARRAY['revenge','revenge traded','tilted in']),
      ('mistakes', 'Not in Plan',
       ARRAY['not in plan','off plan']),
      -- order_flow
      -- 'delta unwind' is deliberately NOT here. A dedicated Delta Unwind tag
      -- exists and matches that phrase on its own label, so aliasing it onto
      -- Delta Fade made one phrase produce two tags for the same concept. The
      -- more specific tag wins, and it is the trader's own wording.
      ('order_flow', 'Delta Fade',
       ARRAY['delta fade','delta faded','faded the delta']),
      ('order_flow', 'Delta Unwind',
       ARRAY['unwound','unwinding','delta unwound']),
      ('order_flow', 'Delta Flip',
       ARRAY['delta flip','flipped delta']),
      ('order_flow', 'Absorption/Exhaustion (Countermov)',
       ARRAY['no continuation','absorbed','absorption','got absorbed','no follow through',
             'selling fail','buying fail','sellers failed','buyers failed','failed to get lower','failed to get higher']),
      ('order_flow', 'Following Buying/Selling Strength',
       ARRAY['following strength','with the strength','buyers stepping in','sellers stepping in']),
      -- setups
      ('setups', 'Break And Retest',
       ARRAY['break and retest','break retest','entered on the retest']),
      ('setups', 'IB Fade',
       ARRAY['ib fade','faded the ib']),
      ('setups', 'Supply And Demand',
       ARRAY['supply and demand','supply zone','demand zone']),
      -- trade_management
      ('trade_management', 'Early Exit',
       ARRAY['exited early','got out early','scared to give back','cut it early']),
      ('trade_management', 'Orderflow Exit',
       ARRAY['orderflow exit','exited on flow','flow turned'])
    ) AS t(cat, lbl, als)
  LOOP
    EXECUTE format(
      'UPDATE trade_tags SET aliases = %L WHERE %s category = %L AND label = %L AND aliases IS NULL',
      s.als, scope, s.cat, s.lbl);
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  RAISE NOTICE 'seeded aliases on % tag rows', total;
END $$;
