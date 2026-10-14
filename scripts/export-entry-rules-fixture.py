import json, sys
import numpy as np
import pandas as pd

base, out = sys.argv[1], sys.argv[2]
T = pd.read_pickle(base + r'\delta_bars\entries_2026-09-30\o10_trades.pkl')
te = pd.to_datetime(T.t_entry)
if te.dt.tz is not None:
    te = te.dt.tz_convert('America/Los_Angeles').dt.tz_localize(None)


def b(x):
    if x is None or (isinstance(x, float) and np.isnan(x)) or x is pd.NA:
        return None
    return bool(x)


def f(x):
    try:
        x = float(x)
    except Exception:
        return None
    return None if np.isnan(x) else x


rows = []
for i, r in T.iterrows():
    t = te.loc[i]
    tape = f(r.dom60) * r.sgn if f(r.dom60) is not None else None
    rows.append({
        'i': int(i),
        'pt': t.strftime('%Y-%m-%d %H:%M:%S.%f'),
        'sgn': int(r.sgn), 'px': f(r.px), 'pnl': f(r.pnl), 'src': str(r.src),
        'run_against': f(r.run_against), 'ha_run': f(r.ha_run), 'dom60': f(r.dom60),
        'L1': b(r.run_against < 3) if f(r.run_against) is not None else None,
        'L2': b(abs(tape) < 2) if tape is not None else None,
        'L3': b(r.run_against == 0) if f(r.run_against) is not None else None,
        'L4': (None if pd.isna(r.rg_fade) else (not bool(r.rg_fade))),
        'F3': (None if pd.isna(r.r3_spike) else (not bool(r.r3_spike))),
        'F5': b(not (tape <= -2)) if tape is not None else None,
        'F6': b(not (r.ha_run >= 2)) if f(r.ha_run) is not None else None,
    })
json.dump(rows, open(out, 'w'), indent=0)
print(len(rows), 'rows ->', out)
