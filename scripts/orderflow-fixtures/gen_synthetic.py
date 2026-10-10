"""Synthetic golden fixture for the order-flow parity test — no market data,
no trades, safe to commit. Expected values come from the Python REFERENCE's own
functions (blind_server.bubble_chart / value_area) and Python/numpy rounding.

    python -B scripts/orderflow-fixtures/gen_synthetic.py scripts/fixtures/orderflow-synthetic.json

Tick streams are generated from a xorshift32 PRNG that the TypeScript test
re-implements, so the fixture stores only seeds + expected outputs (plus a
checksum proving both sides generated the same ticks). The stream deliberately
hits every acceptance branch of the bubble study: volume ties on single- and
multi-trade records, ties with a missing ask, zero-volume records, zero
prices, bid+ask = 0, off-tick and exact half-tick ES prices, and large prints
that dedupe / cluster.

Then run gen_viewer_expected.mjs --synthetic on the same file to add the
viewer-side expectations for the synthetic payload.
"""
import sys, os, json, io, contextlib
sys.dont_write_bytecode = True
sys.path.insert(0, r"D:\Documents\NQ_backtest\delta_bars\entries_2026-09-30\retag_work")
with contextlib.redirect_stdout(io.StringIO()):
    import blind_server as bs
import numpy as np, pandas as pd

M32 = 0xFFFFFFFF


class XS:
    def __init__(self, seed):
        self.x = seed & M32 or 1

    def __call__(self):
        x = self.x
        x ^= (x << 13) & M32
        x ^= x >> 17
        x ^= (x << 5) & M32
        self.x = x & M32
        return self.x


US0 = int((pd.Timestamp("2026-07-21 16:00:00") - bs.EP) // pd.Timedelta(microseconds=1))


def synth_ticks(seed, n, base_tk, big, es_offgrid):
    """Mirror of synthTicks() in scripts/test-orderflow-parity.ts — keep in lockstep."""
    r = XS(seed)
    tk = base_tk
    us = US0
    rows = []
    for i in range(n):
        tk += (r() % 5) - 2
        us += 1 + r() % 40000
        kind = r() % 100
        nt = 1 if r() % 10 < 8 else 1 + r() % 3
        v = 1 + r() % 8
        if r() % 100 < 4:
            v = big // 2 + r() % (2 * big)
        bid = tk - (r() % 2)
        ask = bid + 1
        px, hh, ll = ask / 4, ask / 4, bid / 4
        bv = av = 0
        if kind < 45:
            av = v
        elif kind < 88:
            bv = v; px = bid / 4
        elif kind < 94:                       # volume tie
            v = 2 * v; bv = av = v // 2
            w = r() % 3
            px = ask / 4 if w == 0 else (bid / 4 if w == 1 else (ask + bid) / 8)
        elif kind < 95:
            v = 0                             # zero-volume record (load_ticks drops it; kept here)
        elif kind < 96:
            av = v; px = 0.0                  # zero price
        elif kind < 97:
            pass                              # v > 0 but bid + ask = 0
        elif kind < 98:
            v = 2 * v; bv = av = v // 2; nt = 1; hh = 0.0   # tie, ask missing
        else:
            av = v                            # plain buy
        if es_offgrid and r() % 50 == 0:
            px += 0.125 if r() % 2 else 0.1   # exact half tick / off-grid
        rows.append((us, px, hh, ll, v, bv, av, nt))
    T = pd.DataFrame(rows, columns=["us", "px", "hh", "ll", "v", "bv", "av", "nt"])
    for c in ("us", "v", "bv", "av", "nt"):
        T[c] = T[c].astype(np.int64)
    return T


def checksum(T):
    # Python ints for the time sum: an int64 sum of ~10k Sierra timestamps overflows.
    return {"n": int(len(T)), "sum_us_mod": sum(int(u) for u in T.us) % 1000000007, "sum_px4": float((T.px * 4).sum()),
            "sum_v": int(T.v.sum()), "sum_bv": int(T.bv.sum()), "sum_av": int(T.av.sum()), "sum_nt": int(T.nt.sum()),
            "sum_hh4": float((T.hh * 4).sum()), "sum_ll4": float((T.ll * 4).sum())}


def jsonable(x):
    return json.loads(json.dumps(x, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


def main():
    out = sys.argv[1]
    doc = {"us0": US0, "bubbles": [], "value_area": [], "py_round": [], "np_percentile": []}

    cases = [("NQ", 11, 7000, 4 * 20000, 50, False, 4000),
             ("NQ", 12, 7000, 4 * 20000, 50, False, 37),
             ("ES", 21, 12000, 4 * 6000, 100, True, 4000),
             ("ES", 22, 12000, 4 * 6000, 100, True, 60),
             ("NQ", 31, 1, 4 * 20000, 50, False, 4000),
             ("NQ", 32, 39, 4 * 20000, 50, False, 4000),
             ("NQ", 33, 45, 4 * 20000, 50, False, 4000),
             ("ES", 34, 230, 4 * 6000, 100, True, 4000)]
    for inst, seed, n, base, big, offgrid, maxb in cases:
        T = synth_ticks(seed, n, base, big, offgrid)
        b = bs.bubble_chart(T, inst, maxb=maxb)
        doc["bubbles"].append({"inst": inst, "seed": seed, "n": n, "base_tk": base, "big": big, "es_offgrid": offgrid,
                               "maxb": maxb, "checksum": checksum(T), "expect": jsonable(b)})
        print(inst, seed, n, "->", None if b is None else f"{b['n']} bubbles, {len(b['marks'])} marks, live {b['live_trades']}")

    r = XS(77)
    for k in range(40):
        m = 1 + r() % 60
        lo = 80000 + r() % 50
        ticks = np.array([lo + r() % 25 for _ in range(m)], dtype=np.int64)
        vols = np.array([(r() % 6) * (1 + r() % 3) for _ in range(m)], dtype=np.int64)
        if k % 7 == 0:
            vols[:] = 3                       # all-equal volumes (tie-breaking)
        if k == 5:
            vols[:] = 0                       # zero total -> None
        va = bs.value_area(ticks, vols)
        doc["value_area"].append({"ticks": ticks.tolist(), "vols": vols.tolist(), "expect": va})

    xs = [0.125, 0.375, 2.675, 13.125, 13.375, 1.005, -0.125, -2.5, 2.5, 3.5, 0.5, 1.5, 29935.125, 7545.875,
          12.3456789, -7.0050001, 1e-9, 123456.785, 0.0, 99.995, 8.6607142857142857, 2.4999999999999996]
    for x in xs:
        for nd in (0, 1, 2):
            doc["py_round"].append([x, nd, round(x, nd)])
    rr = XS(99)
    qs = [99.5, 50.0, 0.0, 100.0, 80.0, 99.9, 33.3]
    for k in range(25):
        m = 1 + rr() % 300
        a = np.array([float(rr() % 1000) for _ in range(m)])
        doc["np_percentile"].append({"a": a.astype(int).tolist(), "q": qs, "expect": [float(np.percentile(a, q)) for q in qs]})

    # synthetic payload for the viewer-side functions (bars + volume-at-price)
    r = XS(4242)
    t0 = int((pd.Timestamp("2026-07-20 06:00:00") - pd.Timestamp("1970-01-01")) // pd.Timedelta(seconds=1))
    nb = 140
    B = {k: [] for k in ("t", "o", "h", "l", "c", "v", "bv", "av", "d", "dmin", "dmax", "pv", "vv")}
    vap = {"m": [], "t": [], "b": [], "a": []}
    tk = 4 * 20000
    for i in range(nb):
        t = t0 + 60 * i + (7200 if i >= 70 else 0)      # crosses 06:30 (rth mark), then a 2h gap (eth mark)
        lo_tk = tk - r() % 12
        hi_tk = lo_tk + r() % 30
        o_tk = lo_tk + r() % (hi_tk - lo_tk + 1)
        c_tk = lo_tk + r() % (hi_tk - lo_tk + 1)
        tk = c_tk
        sb = sa = 0; pv = 0.0
        for p in range(lo_tk, hi_tk + 1):
            if r() % 4 == 0:
                continue
            bb = r() % 40; aa = r() % 40
            if r() % 15 == 0:
                aa *= 6
            vap["m"].append(i); vap["t"].append(p); vap["b"].append(bb); vap["a"].append(aa)
            sb += bb; sa += aa; pv += (p / 4) * (bb + aa)
        d = sa - sb
        for k, v in (("t", t), ("o", o_tk / 4), ("h", hi_tk / 4), ("l", lo_tk / 4), ("c", c_tk / 4),
                     ("v", sb + sa), ("bv", sb), ("av", sa), ("d", d), ("dmin", min(0, d) - r() % 30),
                     ("dmax", max(0, d) + r() % 30), ("pv", pv), ("vv", sb + sa)):
            B[k].append(v)
    for k in ("buy_v", "buy_px", "sell_v", "sell_px", "v40", "d40", "p40", "n40"):
        B[k] = [None] * nb                    # legacy 1m-bubble columns the viewer's prep() reads; not ported
    entry = B["t"][-1] + 37
    doc["payload"] = {
        "row": {"date": "2026-07-20", "weekday": "Mon", "time": "11:" + f"{(entry // 60) % 60:02d}" + ":37",
                "inst": "NQ", "direction": "long", "price": B["c"][-1]},
        "has_partial": True, "lpt": 50, "bars": B, "vap": vap, "levels": [], "bubbles": None,
        "bracket": {"atr": 9.5, "stop": B["c"][-1] - 9.5, "tp": B["c"][-1] + 19, "stop_src": "assumed 1 ATR", "tp_src": "assumed 2 ATR"},
        "times": {"entry": entry, "rth_open": t0 + 30 * 60, "rth_close": t0 + 420 * 60,
                  "ib_end": t0 + 90 * 60, "prior_open": t0, "prior_close": t0 + 40 * 60,
                  "eth_start": t0 + 20 * 60, "profile_anchor": t0 + 30 * 60, "in_rth": True},
    }
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"), allow_nan=False)
    print("wrote", out, os.path.getsize(out) // 1024, "KB")


if __name__ == "__main__":
    main()
