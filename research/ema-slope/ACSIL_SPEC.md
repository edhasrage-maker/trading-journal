# Sierra Chart / ACSIL — "9 EMA Slope + Time Window" FILTER study

This is a **filter / condition indicator only** — no orders, no entry/exit logic. It highlights when the
two parameters we settled on are both true, so you can eyeball (or alert on) when the regime is right to
look for the setup:

1. **5-min 9 EMA slope ≥ 2.0 points per 5-min bar** (direction-aligned magnitude), and
2. **time is inside the 07:00–11:00 PT entry window.**

Optional toggles add the other discussed parameters (price on the slope's side; ≥ 0.5× ATR separation),
all default OFF so the core filter is just slope + time.

---

## Apply it to a 5-minute chart
The slope is defined on 5-minute bars, so run this study **on a 5-minute NQ chart** — then EMA, slope and
the per-bar evaluation are all native and exact. (If you want it on your 1-min chart instead, reference a
5-min chart's EMA via `sc.GetStudyArrayFromChartUsingID` and map bars with
`sc.GetContainingIndexForSCDateTime` — but on a 5-min chart it's trivial.)

## Inputs
| Input | Default | Meaning |
|---|---|---|
| EMA Length | 9 | EMA on 5-min Last |
| Slope Lookback (bars) | 3 | slope = (EMA[i] − EMA[i−3]) / 3 |
| Min \|Slope\| (pts/bar) | 2.0 | the steepness floor |
| Window Start (HHMM, chart TZ) | 700 | 07:00 |
| Window End (HHMM, chart TZ) | 1100 | 11:00 |
| Require price on slope side | No | optional bias: up-slope→price>EMA, down→price<EMA |
| Require ≥ ATR separation | No | optional: \|Close−EMA\| ≥ 0.5×ATR |
| ATR Length / × | 10 / 0.5 | only used if the separation toggle is on |

## Outputs
- **Slope** subgraph (line, own region) — so you can watch the steepness number directly.
- **Active** subgraph — `1` when all enabled conditions hold, else `0`. Drawn as a **background color**:
  green when active & sloping up (long regime), red when active & sloping down (short regime).
- Fires a Sierra **alert** when Active turns on at a bar close (optional, wire to your alert sound).

## Behavior (what "active" means)
```
slope  = (EMA[i] − EMA[i−Lookback]) / Lookback          // pts per 5-min bar
steep  = |slope| >= MinSlope
inWin  = (HHMM of bar, chart TZ) in [Start, End)
biasOK = (toggle off) OR (slope>0 && Close>EMA) OR (slope<0 && Close<EMA)
sepOK  = (toggle off) OR |Close − EMA| >= 0.5 * ATR(10)
Active = steep AND inWin AND biasOK AND sepOK
```

## Drop-in ACSIL skeleton
```cpp
#include "sierrachart.h"
SCDLLNAME("9 EMA Slope + Time Filter")

SCSFExport scsf_EMASlopeTimeFilter(SCStudyInterfaceRef sc)
{
    SCSubgraphRef Slope  = sc.Subgraph[0];
    SCSubgraphRef Active = sc.Subgraph[1];
    SCSubgraphRef EMA    = sc.Subgraph[2];
    SCSubgraphRef ATR    = sc.Subgraph[3];

    SCInputRef In_Len      = sc.Input[0];
    SCInputRef In_Lookback = sc.Input[1];
    SCInputRef In_MinSlope = sc.Input[2];
    SCInputRef In_Start    = sc.Input[3];
    SCInputRef In_End      = sc.Input[4];
    SCInputRef In_BiasReq  = sc.Input[5];
    SCInputRef In_SepReq   = sc.Input[6];
    SCInputRef In_ATRLen   = sc.Input[7];
    SCInputRef In_SepFrac  = sc.Input[8];

    if (sc.SetDefaults)
    {
        sc.GraphName   = "9 EMA Slope + Time Filter";
        sc.GraphRegion = 1;            // slope line in its own region
        sc.AutoLoop    = 1;

        Slope.Name = "Slope (pts/bar)"; Slope.DrawStyle = DRAWSTYLE_LINE;       Slope.PrimaryColor = RGB(80,160,255);
        Active.Name= "Active";          Active.DrawStyle = DRAWSTYLE_BACKGROUND; // colors price-bar background
        EMA.Name   = "EMA";             EMA.DrawStyle    = DRAWSTYLE_IGNORE;
        ATR.Name   = "ATR";             ATR.DrawStyle    = DRAWSTYLE_IGNORE;

        In_Len.Name="EMA Length";                 In_Len.SetInt(9);
        In_Lookback.Name="Slope Lookback (bars)"; In_Lookback.SetInt(3);
        In_MinSlope.Name="Min |Slope| (pts/bar)"; In_MinSlope.SetFloat(2.0f);
        In_Start.Name="Window Start (HHMM)";      In_Start.SetInt(700);
        In_End.Name="Window End (HHMM)";          In_End.SetInt(1100);
        In_BiasReq.Name="Require price on slope side"; In_BiasReq.SetYesNo(0);
        In_SepReq.Name="Require >= ATR separation";    In_SepReq.SetYesNo(0);
        In_ATRLen.Name="ATR Length";              In_ATRLen.SetInt(10);
        In_SepFrac.Name="Separation x ATR";       In_SepFrac.SetFloat(0.5f);
        return;
    }

    sc.MovingAverage(sc.BaseDataIn[SC_LAST], EMA, MOVAVGTYPE_EXPONENTIAL, In_Len.GetInt());
    sc.ATR(sc.BaseDataIn, ATR, In_ATRLen.GetInt(), MOVAVGTYPE_WILDERS);

    const int i  = sc.Index;
    const int lb = In_Lookback.GetInt();
    if (i < lb) { Slope[i] = 0; Active[i] = 0; return; }

    float slope = (EMA[i] - EMA[i - lb]) / lb;
    Slope[i] = slope;

    // Time-of-day in the chart's time zone -> HHMM. Set Sierra's Time Zone to your PT reference.
    SCDateTime dt = sc.BaseDateTimeIn[i];
    int hm = dt.GetHour() * 100 + dt.GetMinute();
    bool inWin = (hm >= In_Start.GetInt() && hm < In_End.GetInt());

    bool steep  = fabs(slope) >= In_MinSlope.GetFloat();
    float close = sc.BaseDataIn[SC_LAST][i];
    bool biasOK = !In_BiasReq.GetYesNo()
                || (slope > 0 && close > EMA[i]) || (slope < 0 && close < EMA[i]);
    bool sepOK  = !In_SepReq.GetYesNo()
                || fabs(close - EMA[i]) >= In_SepFrac.GetFloat() * ATR[i];

    bool active = steep && inWin && biasOK && sepOK;
    Active[i] = active ? 1.0f : 0.0f;
    Active.DataColor[i] = active ? (slope > 0 ? RGB(0,80,0) : RGB(90,0,0)) : RGB(0,0,0);

    if (active && i == sc.ArraySize - 1 && sc.GetBarHasClosedStatus(i) == BHCS_BAR_HAS_CLOSED)
        sc.SetAlert(0, "9 EMA filter active");
}
```

## Notes / gotchas
- **Time zone:** `GetHour()/GetMinute()` return the bar time in the **chart's** time zone (Sierra → Global
  Settings → Time Zone, DST-aware). Set it to your PT reference, or change the HHMM inputs to match whatever
  TZ the chart is in.
- **Slope units depend on the chart timeframe.** Apply to a **5-minute** chart so "pts/bar" = "pts per 5-min
  bar" (what the 2.0 floor was tuned to). On a 1-min chart the same input would mean something different.
- This study is purely a green-light. It does **not** know about pullbacks, fills, stops, or targets — those
  stay discretionary (or in the full engine). It just answers: *"is the trend steep enough and is it the
  right time of day?"*
