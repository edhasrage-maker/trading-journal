-- 2026-06-02 — Emotion vocabulary redesign.
--
-- Collapsed the emotion tag library from ~6 active values down to 3:
--   Stable  |  Compromised  |  MAXRAGE
--
-- Three statements, run in order:
--   (1) library rename: MAX RAGE → MAXRAGE
--   (2) UPDATE trades.tags_json.emotions onto the new vocab
--   (3) UPDATE historical_trades.tags_json.emotions onto the new vocab
--
-- Mapping rules:
--   Calm                                  → Stable
--   Frustrated/Angry, Pissed Off_angry    → MAXRAGE
--   Already-canonical (Stable / Compromised / MAXRAGE) → unchanged
--   Anything else (Rushed, Anxious, etc.) → Compromised
--
-- Mirror in code: mapEmotionToCurrentVocab() in src/lib/tradezella-import.ts
-- so a future Tradezella re-import doesn't reintroduce the old values.

-- (1) Library rename
UPDATE trade_tags
SET label = 'MAXRAGE'
WHERE category = 'emotions' AND label = 'MAX RAGE';

-- (2) Native trades
UPDATE trades
SET tags_json = jsonb_set(
  tags_json,
  '{emotions}',
  COALESCE(
    (
      SELECT jsonb_agg(DISTINCT mapped)
      FROM (
        SELECT
          CASE
            WHEN elem = 'Calm' THEN 'Stable'
            WHEN elem IN ('Frustrated/Angry', 'Pissed Off_angry') THEN 'MAXRAGE'
            WHEN elem IN ('Stable', 'Compromised', 'MAXRAGE') THEN elem
            ELSE 'Compromised'
          END AS mapped
        FROM jsonb_array_elements_text(tags_json->'emotions') AS elem
      ) AS mapping
    ),
    '[]'::jsonb
  )
)
WHERE tags_json IS NOT NULL
  AND tags_json ? 'emotions'
  AND jsonb_array_length(tags_json->'emotions') > 0;

-- (3) Historical (Tradezella) trades
UPDATE historical_trades
SET tags_json = jsonb_set(
  tags_json,
  '{emotions}',
  COALESCE(
    (
      SELECT jsonb_agg(DISTINCT mapped)
      FROM (
        SELECT
          CASE
            WHEN elem = 'Calm' THEN 'Stable'
            WHEN elem IN ('Frustrated/Angry', 'Pissed Off_angry') THEN 'MAXRAGE'
            WHEN elem IN ('Stable', 'Compromised', 'MAXRAGE') THEN elem
            ELSE 'Compromised'
          END AS mapped
        FROM jsonb_array_elements_text(tags_json->'emotions') AS elem
      ) AS mapping
    ),
    '[]'::jsonb
  )
)
WHERE tags_json IS NOT NULL
  AND tags_json ? 'emotions'
  AND jsonb_array_length(tags_json->'emotions') > 0;
