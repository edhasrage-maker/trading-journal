# Sierra Chart / ACSIL — "9 EMA Slope + Time Window" FILTER study

A **condition indicator only** — no orders, no entry/exit logic. It draws the 9 EMA and **colors the line
itself**: the EMA shows in its normal color when the regime is valid, and **greys out** when it isn't, so the
line on your chart is only "lit" when it's worth looking for the setup.

**Valid** = both of the parameters we settled on are true:
1. 5-min 9 EMA **slope ≥ 2.0 points per 5-min bar** (direction-aligned magnitude), and
2. time is **inside 07:00–11:00 PT**.

Optional toggles (default OFF) add the other discussed parameters: price on the slope's side, and ≥ 0.5× ATR
separation. When any enabled condition fails, the EMA segment is greyed.

---

## Apply it to a 5-minute chart
The slope is defined on 5-minute bars, so run this on a **5-minute NQ chart** (overlaid on price). It draws
its own 9 EMA — hide your existing EMA and use this one, since it's the same line just conditionally colored.
(If you must run it on a 1-min chart, reference a 5-min EMA via `sc.GetStudyArrayFromChartUsingID` and map
bars with `sc.GetContainingIndexForSCDateTime` — but on a 5-min chart it's trivial.)

## Inputs
| Input | Default | Meaning |
|---|---|---|
| EMA Length | 9 | EMA on 5-min Last |
| Slope Lookback (bars) | 3 | slope = (EMA[i] − EMA[i−3]) / 3 |
| Min \|Slope\| (pts/bar) | 2.0 | steepness floor |
| Window Start (HHMM, chart TZ) | 700 | 07:00 |
| Window End (HHMM, chart TZ) | 1100 | 11:00 |
| Require price on slope side | No | optional bias |
| Require ≥ ATR separation | No | optional, \|Close−EMA\| ≥ frac×ATR |
| ATR Length / Separation × | 10 / 0.5 | only if separation toggle on |
| Invalid (greyed) color | grey | the "not valid" color |

The **valid** color is just the EMA subgraph's own Color setting — set it to whatever you normally use; the
study only swaps in the grey when the filter is off.

## Output
- One subgraph: the **9 EMA**, drawn on price. Per bar, its `DataColor` is set to the EMA's normal color
  when valid, or the grey input color when not. (Slope is computed into a hidden subgraph if you want to
  reference it elsewhere.)

## Behavior
```
slope  = (EMA[i] − EMA[i−Lookback]) / Lookback          // pts per 5-min bar
steep  = |slope| >= MinSlope
inWin  = (HHMM of bar, chart TZ) in [Start, End)
biasOK = (toggle off) OR (slope>0 && Close>EMA) OR (slope<0 && Close<EMA)
sepOK  = (toggle off) OR |Close − EMA| >= frac * ATR
valid  = steep AND inWin AND biasOK AND sepOK
EMA line color at bar i = valid ? (normal EMA color) : grey
```

## Drop-in ACSIL skeleton
```cpp
#include "sierrachart.h"
SCDLLNAME("9 EMA Slope + Time Filter")

SCSFExport scsf_EMASlopeTimeFilter(SCStudyInterfaceRef sc)
{
    SCSubgraphRef EMA   = sc.Subgraph[0];   // the line we draw + color
    SCSubgraphRef Slope = sc.Subgraph[1];   // computed, not drawn
    SCSubgraphRef ATR   = sc.Subgraph[2];   // computed, not drawn

    SCInputRef In_Len      = sc.Input[0];
    SCInputRef In_Lookback = sc.Input[1];
    SCInputRef In_MinSlope = sc.Input[2];
    SCInputRef In_Start    = sc.Input[3];
    SCInputRef In_End      = sc.Input[4];
    SCInputRef In_BiasReq  = sc.Input[5];
    SCInputRef In_SepReq   = sc.Input[6];
    SCInputRef In_ATRLen   = sc.Input[7];
    SCInputRef In_SepFrac  = sc.Input[8];
    SCInputRef In_Grey     = sc.Input[9];

    if (sc.SetDefaults)
    {
        sc.GraphName   = "9 EMA Slope + Time Filter";
        sc.GraphRegion = 0;            // overlay on the price chart
        sc.AutoLoop    = 1;

        EMA.Name = "9 EMA";  EMA.DrawStyle = DRAWSTYLE_LINE;  EMA.LineWidth = 2;
        EMA.PrimaryColor = RGB(255,215,0);          // <-- your normal/"valid" EMA color
        Slope.Name = "Slope (pts/bar)";  Slope.DrawStyle = DRAWSTYLE_IGNORE;
        ATR.Name   = "ATR";              ATR.DrawStyle   = DRAWSTYLE_IGNORE;

        In_Len.Name="EMA Length";                 In_Len.SetInt(9);
        In_Lookback.Name="Slope Lookback (bars)"; In_Lookback.SetInt(3);
        In_MinSlope.Name="Min |Slope| (pts/bar)"; In_MinSlope.SetFloat(2.0f);
        In_Start.Name="Window Start (HHMM)";      In_Start.SetInt(700);
        In_End.Name="Window End (HHMM)";          In_End.SetInt(1100);
        In_BiasReq.Name="Require price on slope side"; In_BiasReq.SetYesNo(0);
        In_SepReq.Name="Require >= ATR separation";    In_SepReq.SetYesNo(0);
        In_ATRLen.Name="ATR Length";              In_ATRLen.SetInt(10);
        In_SepFrac.Name="Separation x ATR";       In_SepFrac.SetFloat(0.5f);
        In_Grey.Name="Invalid (greyed) color";    In_Grey.SetColor(RGB(110,110,110));
        return;
    }

    sc.MovingAverage(sc.BaseDataIn[SC_LAST], EMA, MOVAVGTYPE_EXPONENTIAL, In_Len.GetInt());
    sc.ATR(sc.BaseDataIn, ATR, In_ATRLen.GetInt(), MOVAVGTYPE_WILDERS);

    const int i  = sc.Index;
    const int lb = In_Lookback.GetInt();
    if (i < lb) { EMA.DataColor[i] = In_Grey.GetColor(); return; }

    float slope = (EMA[i] - EMA[i - lb]) / lb;
    Slope[i] = slope;

    SCDateTime dt = sc.BaseDateTimeIn[i];
    int hm = dt.GetHour() * 100 + dt.GetMinute();
    bool inWin  = (hm >= In_Start.GetInt() && hm < In_End.GetInt());
    bool steep  = fabs(slope) >= In_MinSlope.GetFloat();
    float close = sc.BaseDataIn[SC_LAST][i];
    bool biasOK = !In_BiasReq.GetYesNo() || (slope > 0 && close > EMA[i]) || (slope < 0 && close < EMA[i]);
    bool sepOK  = !In_SepReq.GetYesNo()  || fabs(close - EMA[i]) >= In_SepFrac.GetFloat() * ATR[i];

    bool valid = steep && inWin && biasOK && sepOK;

    // Highlight the EMA in its normal color when valid; grey it out when not.
    EMA.DataColor[i] = valid ? EMA.PrimaryColor : In_Grey.GetColor();
}
```

## Notes / gotchas
- **Per-bar line color** is done with `Subgraph.DataColor[i]` on a `DRAWSTYLE_LINE` subgraph; set it on every
  bar (valid → `EMA.PrimaryColor`, invalid → grey) so there are no uncolored gaps.
- **`GraphRegion = 0`** so the EMA overlays the price chart (not a sub-pane).
- **Time zone:** `GetHour()/GetMinute()` use the **chart's** time zone (Sierra → Global Settings → Time Zone,
  DST-aware). Set it to your PT reference, or change the HHMM inputs to match the chart's TZ.
- **Slope units depend on the timeframe** — apply to a **5-minute** chart so the 2.0 floor means pts per
  5-min bar (what it was tuned to).
- Pure visual green-light: no pullback/fill/stop logic. The line is lit only when the trend is steep enough
  and it's the right time of day.
