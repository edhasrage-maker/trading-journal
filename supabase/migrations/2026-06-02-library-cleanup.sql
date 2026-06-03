-- 2026-06-02 — Tag library cleanup.
--
-- Two cleanups:
--   (1) Merge "EMA continuation" and "EMA Continuation" into one canonical
--       label. Keep the lowercase-c variant (matches trade tag history).
--   (2) Rename "No Confirmation Of Buying_selling Stepping In" — the
--       underscore and odd casing came from the Tradezella import and
--       reads weirdly.
--
-- This script is idempotent: re-running it is a no-op once applied.

-- (1) EMA continuation case-merge
--     Step 1a: rewrite tag values on trades from the to-be-deleted variant
UPDATE trades
SET tags_json = jsonb_set(
  tags_json,
  '{setups}',
  (
    SELECT jsonb_agg(DISTINCT
      CASE WHEN elem = 'EMA Continuation' THEN 'EMA continuation' ELSE elem END
    )
    FROM jsonb_array_elements_text(tags_json->'setups') AS elem
  )
)
WHERE tags_json ? 'setups'
  AND tags_json->'setups' @> '["EMA Continuation"]';

UPDATE historical_trades
SET tags_json = jsonb_set(
  tags_json,
  '{setups}',
  (
    SELECT jsonb_agg(DISTINCT
      CASE WHEN elem = 'EMA Continuation' THEN 'EMA continuation' ELSE elem END
    )
    FROM jsonb_array_elements_text(tags_json->'setups') AS elem
  )
)
WHERE tags_json ? 'setups'
  AND tags_json->'setups' @> '["EMA Continuation"]';

--     Step 1b: drop the duplicate library row
DELETE FROM trade_tags
WHERE category = 'setups' AND label = 'EMA Continuation';

-- (2) Mistakes label cleanup
--     Step 2a: rename historical references
UPDATE trades
SET tags_json = jsonb_set(
  tags_json,
  '{mistakes}',
  (
    SELECT jsonb_agg(DISTINCT
      CASE WHEN elem = 'No Confirmation Of Buying_selling Stepping In'
           THEN 'No Confirmation of Buyers/Sellers Stepping In'
           ELSE elem END
    )
    FROM jsonb_array_elements_text(tags_json->'mistakes') AS elem
  )
)
WHERE tags_json ? 'mistakes'
  AND tags_json->'mistakes' @> '["No Confirmation Of Buying_selling Stepping In"]';

UPDATE historical_trades
SET tags_json = jsonb_set(
  tags_json,
  '{mistakes}',
  (
    SELECT jsonb_agg(DISTINCT
      CASE WHEN elem = 'No Confirmation Of Buying_selling Stepping In'
           THEN 'No Confirmation of Buyers/Sellers Stepping In'
           ELSE elem END
    )
    FROM jsonb_array_elements_text(tags_json->'mistakes') AS elem
  )
)
WHERE tags_json ? 'mistakes'
  AND tags_json->'mistakes' @> '["No Confirmation Of Buying_selling Stepping In"]';

--     Step 2b: rename the library row
UPDATE trade_tags
SET label = 'No Confirmation of Buyers/Sellers Stepping In'
WHERE category = 'mistakes' AND label = 'No Confirmation Of Buying_selling Stepping In';
