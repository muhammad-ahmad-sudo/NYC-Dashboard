#!/usr/bin/env python3

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


DT_FORMAT = "%m-%d-%y %H:%M"


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path to raw trip CSV")
    ap.add_argument("--out", required=True, help="Output directory (e.g., web/data)")
    ap.add_argument("--sample", type=int, default=50000, help="Sample size for sample.csv")
    ap.add_argument("--random-seed", type=int, default=42)
    return ap.parse_args()


def main():
    args = parse_args()
    in_path = Path(args.input)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    usecols = [
        "tpep_pickup_datetime",
        "tpep_dropoff_datetime",
        "passenger_count",
        "trip_distance",
        "PULocationID",
        "DOLocationID",
        "payment_type",
        "fare_amount",
        "tip_amount",
        "total_amount",
    ]

    print(f"Reading: {in_path}")
    df = pd.read_csv(in_path, usecols=usecols, low_memory=False)
    rows_raw = int(len(df))

    # Parse datetimes
    df["pickup_dt"] = pd.to_datetime(df["tpep_pickup_datetime"], format=DT_FORMAT, errors="coerce")
    df["dropoff_dt"] = pd.to_datetime(df["tpep_dropoff_datetime"], format=DT_FORMAT, errors="coerce")

    # Coerce numerics
    for c in [
        "passenger_count",
        "trip_distance",
        "PULocationID",
        "DOLocationID",
        "payment_type",
        "fare_amount",
        "tip_amount",
        "total_amount",
    ]:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df["duration_min"] = (df["dropoff_dt"] - df["pickup_dt"]).dt.total_seconds() / 60.0
    df["date"] = df["pickup_dt"].dt.floor("D")
    df["hour"] = df["pickup_dt"].dt.hour
    df["dow"] = df["pickup_dt"].dt.dayofweek  # Monday=0

    # Light cleaning
    valid = (
        df["pickup_dt"].notna()
        & df["dropoff_dt"].notna()
        & (df["duration_min"] > 0)
        & (df["duration_min"] <= 180)
        & (df["trip_distance"] > 0)
        & (df["trip_distance"] <= 50)
        & (df["total_amount"] > 0)
        & (df["total_amount"] <= 500)
    )
    df = df.loc[valid].copy()

    # --- daily.csv ---
    daily = (
        df.groupby("date")
        .agg(
            trips=("date", "size"),
            avg_distance=("trip_distance", "mean"),
            avg_total=("total_amount", "mean"),
            avg_tip=("tip_amount", "mean"),
            pct_tipped=("tip_amount", lambda s: float((s > 0).mean())),
        )
        .reset_index()
        .sort_values("date")
    )
    daily_out = daily.copy()
    daily_out["date"] = daily_out["date"].dt.strftime("%Y-%m-%d")
    daily_out.to_csv(out_dir / "daily.csv", index=False)
    print(f"Wrote {out_dir/'daily.csv'} ({len(daily_out):,} rows)")

    # --- daily_hour.csv ---
    dh = (
        df.groupby(["date", "dow", "hour"])
        .agg(trips=("hour", "size"), avg_total=("total_amount", "mean"), avg_distance=("trip_distance", "mean"))
        .reset_index()
        .sort_values(["date", "hour"])
    )
    dh_out = dh.copy()
    dh_out["date"] = dh_out["date"].dt.strftime("%Y-%m-%d")
    dh_out["dow"] = dh_out["dow"].astype(int)
    dh_out["hour"] = dh_out["hour"].astype(int)
    dh_out.to_csv(out_dir / "daily_hour.csv", index=False)
    print(f"Wrote {out_dir/'daily_hour.csv'} ({len(dh_out):,} rows)")

    # --- sample.csv ---
    rng = np.random.default_rng(args.random_seed)
    n = min(args.sample, len(df))
    df_sample = df.sample(n=n, random_state=args.random_seed).copy()

    df_sample["pickup_dt_iso"] = df_sample["pickup_dt"].dt.strftime("%Y-%m-%dT%H:%M:%S")
    df_sample["date"] = df_sample["date"].dt.strftime("%Y-%m-%d")

    for col in ["hour", "dow", "passenger_count", "PULocationID", "DOLocationID", "payment_type"]:
        df_sample[col] = df_sample[col].astype(int)

    sample_out = df_sample[
        [
            "pickup_dt_iso",
            "date",
            "hour",
            "dow",
            "passenger_count",
            "trip_distance",
            "duration_min",
            "PULocationID",
            "DOLocationID",
            "payment_type",
            "fare_amount",
            "tip_amount",
            "total_amount",
        ]
    ]
    sample_out.to_csv(out_dir / "sample.csv", index=False)
    print(f"Wrote {out_dir/'sample.csv'} ({len(sample_out):,} rows)")

    # --- meta.json ---
    meta = {
        "dataset": in_path.name,
        "rows_raw": rows_raw,
        "rows_clean": int(len(df)),
        "sample_size": int(len(sample_out)),
        "date_min": str(df['date'].min().date()) if len(df) else None,
        "date_max": str(df['date'].max().date()) if len(df) else None,
    }
    with open(out_dir / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"Wrote {out_dir/'meta.json'}")

    print("\nDone. Next:")
    print("  1) cd web")
    print("  2) python -m http.server 8000")
    print("  3) open http://localhost:8000\n")


if __name__ == "__main__":
    main()
