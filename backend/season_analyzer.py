from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Any

import pandas as pd  # type: ignore

BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "data" / "indian_agri_dataset_15k.csv"
OUTPUT_PATH = BASE_DIR / "data" / "season_recs.json"


def analyze_seasons() -> Dict[str, Any]:
    df = pd.read_csv(DATA_PATH)

    # Keep naming consistent with `ml_service/main.py`
    if "Humidity" in df.columns:
        df = df.rename(columns={"Humidity": "humidity"})

    required = {"Crop", "Season", "N", "P", "K", "Temperature", "humidity", "pH", "Rainfall"}
    missing = required - set(df.columns)
    if missing:
        raise RuntimeError(f"Dataset is missing required columns: {sorted(missing)}")

    season_recs: Dict[str, Any] = {}

    for season, season_df in df.groupby("Season"):
        crop_counts = season_df["Crop"].astype(str).value_counts()
        top_crops = crop_counts.head(5).to_dict()

        avg_features = (
            season_df[["N", "P", "K", "Temperature", "humidity", "pH", "Rainfall"]]
            .mean(numeric_only=True)
            .to_dict()
        )

        season_recs[str(season)] = {
            "top_crops": {str(k): int(v) for k, v in top_crops.items()},
            "count": int(len(season_df)),
            "avg_features": {k: round(float(v), 2) for k, v in avg_features.items()},
        }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(season_recs, f, indent=2, ensure_ascii=False)

    print(f"Saved {OUTPUT_PATH} with {len(season_recs)} seasons")
    return season_recs


if __name__ == "__main__":
    analyze_seasons()

