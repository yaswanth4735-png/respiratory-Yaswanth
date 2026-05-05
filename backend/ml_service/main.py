from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error, parse, request

import numpy as np  # type: ignore
import pandas as pd  # type: ignore
import shap  # type: ignore
import uvicorn  # type: ignore
from dotenv import load_dotenv  # type: ignore
from fastapi import FastAPI, HTTPException  # type: ignore
from fastapi.middleware.cors import CORSMiddleware  # type: ignore
from pydantic import BaseModel, Field, field_validator  # type: ignore
from sklearn.compose import ColumnTransformer  # type: ignore
from sklearn.ensemble import RandomForestClassifier  # type: ignore
from sklearn.preprocessing import OneHotEncoder  # type: ignore

ROOT_DIR = Path(__file__).resolve().parents[2]  # repo root
load_dotenv(dotenv_path=ROOT_DIR / ".env")

DATA_PATH = ROOT_DIR / "backend" / "data" / "indian_agri_dataset_15k.csv"
SEASON_RECS_PATH = ROOT_DIR / "backend" / "data" / "season_recs.json"

app = FastAPI(
    title="Crop Recommendation API",
    description="ML microservice (Random Forest + SHAP) for crop recommendation.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CropFeatures(BaseModel):
    N: float = Field(..., description="Nitrogen")
    P: float = Field(..., description="Phosphorus")
    K: float = Field(..., description="Potassium")
    temperature: float = Field(..., description="Temperature in °C")
    humidity: float = Field(..., ge=0, le=100, description="Relative humidity (%)")
    ph: float = Field(..., ge=0, le=14, description="Soil pH")
    rainfall: float = Field(..., ge=0, description="Rainfall in mm")
    Season: str = Field(..., description="Crop growing season")
    location: str | None = Field(default="India", description="Region/location for market context")

    @field_validator("temperature")
    @classmethod
    def validate_temperature(cls, v: float) -> float:
        if v < -10 or v > 60:
            raise ValueError("temperature looks out of realistic agricultural range")
        return v


class MandiPriceRecord(BaseModel):
    state: str
    district: str
    market: str
    commodity: str
    variety: str
    grade: str = ""
    arrival_date: str = ""
    min_price: float = 0
    max_price: float = 0
    modal_price: float = 0


class PriceSummary(BaseModel):
    min_price: float
    max_price: float
    avg_modal_price: float
    num_markets: int
    commodity_searched: str


class PredictionResponse(BaseModel):
    recommended_crop: str
    confidence: float
    class_probabilities: Dict[str, float]
    shap_explanation: List[Dict[str, Any]]
    market_prices: List[MandiPriceRecord] = []
    price_summary: Optional[PriceSummary] = None
    estimated_investment: float = 0
    estimated_profit: float = 0
    estimated_investment_per_acre: float = 0
    estimated_profit_per_acre: float = 0
    assumed_yield_quintal_per_acre: float = 10
    market_insight: str = ""


class SeasonRecsResponse(BaseModel):
    season: str
    top_crops: Dict[str, int]
    count: int
    avg_features: Dict[str, float]
    model_probs: Dict[str, float]


rf_model: RandomForestClassifier | None = None
shap_explainer: shap.TreeExplainer | None = None
preprocessor: ColumnTransformer | None = None
encoded_feature_names: List[str] = []
feature_names: List[str] = ["N", "P", "K", "Temperature", "humidity", "pH", "Rainfall", "Season"]
class_names: List[str] = []
startup_error: str | None = None


# ---------------------------------------------------------------------------
# Crop name -> data.gov.in commodity name mapping
# The ML model predicts lowercase crop names; the API expects title-case.
# ---------------------------------------------------------------------------
CROP_TO_COMMODITY: Dict[str, str] = {
    "rice": "Rice",
    "maize": "Maize",
    "chickpea": "Bengal Gram(Gram)(Whole)",
    "kidneybeans": "Rajma",
    "pigeonpeas": "Arhar (Tur/Red Gram)(Whole)",
    "mothbeans": "Moth",
    "mungbean": "Green Gram (Moong)(Whole)",
    "blackgram": "Black Gram (Urd Beans)(Whole)",
    "lentil": "Masur Dal",
    "pomegranate": "Pomegranate",
    "banana": "Banana",
    "mango": "Mango",
    "grapes": "Grapes",
    "watermelon": "Water Melon",
    "muskmelon": "Musk Melon",
    "apple": "Apple",
    "orange": "Orange",
    "papaya": "Papaya",
    "coconut": "Coconut",
    "cotton": "Cotton",
    "jute": "Jute",
    "coffee": "Coffee",
}

DATA_GOV_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"


def fetch_mandi_prices(crop: str) -> Dict[str, Any]:
    """Fetch live mandi prices from data.gov.in for a given crop."""
    assumed_yield_quintal_per_acre = float(os.getenv("ASSUMED_YIELD_QUINTAL_PER_ACRE", "10"))

    api_key = os.getenv("DATA_GOV_API_KEY", "")
    if not api_key:
        print("WARN - DATA_GOV_API_KEY not set, skipping mandi price fetch.")
        return {
            "market_prices": [],
            "price_summary": None,
            "estimated_investment": 0.0,
            "estimated_profit": 0.0,
            "estimated_investment_per_acre": 0.0,
            "estimated_profit_per_acre": 0.0,
            "assumed_yield_quintal_per_acre": assumed_yield_quintal_per_acre,
            "market_insight": "DATA_GOV_API_KEY not configured.",
        }

    crop_key = str(crop).strip().lower()
    commodity = CROP_TO_COMMODITY.get(crop_key, crop.strip().title())

    try:
        url = (
            f"https://api.data.gov.in/resource/{DATA_GOV_RESOURCE_ID}"
            f"?api-key={parse.quote(api_key)}"
            f"&format=json"
            f"&limit=10"
            f"&filters[commodity]={parse.quote(commodity)}"
        )
        payload: Dict[str, Any] = {}
        last_error: Exception | None = None
        for timeout in (10, 20):
            try:
                req = request.Request(url, headers={"User-Agent": "crop-recommendation-app/1.0"})
                with request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                last_error = None
                break
            except Exception as retry_err:
                last_error = retry_err
        if last_error is not None:
            raise last_error

        records = payload.get("records", [])
        if not records:
            return {
                "market_prices": [],
                "price_summary": None,
                "estimated_investment": 0.0,
                "estimated_profit": 0.0,
                "estimated_investment_per_acre": 0.0,
                "estimated_profit_per_acre": 0.0,
                "assumed_yield_quintal_per_acre": assumed_yield_quintal_per_acre,
                "market_insight": f"No mandi data found for '{commodity}'.",
            }

        market_prices = []
        for rec in records:
            market_prices.append({
                "state": rec.get("state", ""),
                "district": rec.get("district", ""),
                "market": rec.get("market", ""),
                "commodity": rec.get("commodity", commodity),
                "variety": rec.get("variety", ""),
                "grade": rec.get("grade", ""),
                "arrival_date": rec.get("arrival_date", ""),
                "min_price": float(rec.get("min_price", 0)),
                "max_price": float(rec.get("max_price", 0)),
                "modal_price": float(rec.get("modal_price", 0)),
            })

        all_min = [p["min_price"] for p in market_prices if p["min_price"] > 0]
        all_max = [p["max_price"] for p in market_prices if p["max_price"] > 0]
        all_modal = [p["modal_price"] for p in market_prices if p["modal_price"] > 0]

        price_summary = {
            "min_price": min(all_min) if all_min else 0,
            "max_price": max(all_max) if all_max else 0,
            "avg_modal_price": round(sum(all_modal) / len(all_modal), 2) if all_modal else 0,
            "num_markets": len(market_prices),
            "commodity_searched": commodity,
        }

        avg_modal = float(price_summary["avg_modal_price"])
        min_price = float(price_summary["min_price"])
        max_price = float(price_summary["max_price"])

        estimated_investment = round(min_price, 2)
        estimated_profit = round(max(0.0, avg_modal - min_price), 2)
        estimated_investment_per_acre = round(estimated_investment * assumed_yield_quintal_per_acre, 2)
        estimated_profit_per_acre = round(estimated_profit * assumed_yield_quintal_per_acre, 2)
        spread = max(0.0, max_price - min_price)
        market_insight = (
            f"{commodity}: average modal price is Rs {avg_modal:.2f}/quintal across "
            f"{price_summary['num_markets']} markets; observed spread Rs {spread:.2f}. "
            f"Per-acre estimate uses assumed yield {assumed_yield_quintal_per_acre:.1f} quintal/acre."
        )

        return {
            "market_prices": market_prices,
            "price_summary": price_summary,
            "estimated_investment": estimated_investment,
            "estimated_profit": estimated_profit,
            "estimated_investment_per_acre": estimated_investment_per_acre,
            "estimated_profit_per_acre": estimated_profit_per_acre,
            "assumed_yield_quintal_per_acre": assumed_yield_quintal_per_acre,
            "market_insight": market_insight,
        }

    except Exception as e:
        print(f"WARN - data.gov.in fetch failed: {e}")
        return {
            "market_prices": [],
            "price_summary": None,
            "estimated_investment": 0.0,
            "estimated_profit": 0.0,
            "estimated_investment_per_acre": 0.0,
            "estimated_profit_per_acre": 0.0,
            "assumed_yield_quintal_per_acre": assumed_yield_quintal_per_acre,
            "market_insight": "Unable to fetch mandi data from data.gov.in.",
        }


def load_and_train_model() -> None:
    global rf_model, shap_explainer, class_names, startup_error, preprocessor, encoded_feature_names

    if not DATA_PATH.exists():
        raise RuntimeError(f"Dataset not found at {DATA_PATH}")

    df = pd.read_csv(DATA_PATH)
    if "Humidity" in df.columns:
        df.rename(columns={"Humidity": "humidity"}, inplace=True)

    expected_cols = set(feature_names + ["Crop"])
    missing = expected_cols - set(df.columns)
    if missing:
        raise RuntimeError(f"Dataset is missing expected columns: {sorted(missing)}")

    X = df[feature_names]
    y = df["Crop"].astype(str)

    categorical_features = ["Season"]
    numeric_features = ["N", "P", "K", "Temperature", "humidity", "pH", "Rainfall"]

    preprocessor_obj = ColumnTransformer(
        transformers=[
            ("num", "passthrough", numeric_features),
            ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), categorical_features),
        ]
    )
    X_encoded = preprocessor_obj.fit_transform(X)

    rf = RandomForestClassifier(
        n_estimators=300,
        max_depth=None,
        random_state=42,
        n_jobs=-1,
    )
    rf.fit(X_encoded, y)

    rf_model = rf
    shap_explainer = shap.TreeExplainer(rf)
    class_names = list(rf.classes_)
    preprocessor = preprocessor_obj
    encoded_feature_names = numeric_features + list(
        preprocessor_obj.named_transformers_["cat"].get_feature_names_out(categorical_features)
    )
    startup_error = None


@app.on_event("startup")
def startup_event() -> None:
    global startup_error, rf_model, shap_explainer, class_names
    try:
        load_and_train_model()
    except Exception as e:
        rf_model = None
        shap_explainer = None
        class_names = []
        startup_error = str(e)


@app.get("/health")
def health() -> Dict[str, Any]:
    global startup_error
    if (rf_model is None or shap_explainer is None) and DATA_PATH.exists():
        try:
            load_and_train_model()
        except Exception as e:
            startup_error = str(e)
    return {
        "status": "ok",
        "model_ready": rf_model is not None,
        "features": feature_names,
        "encoded_features": encoded_feature_names,
        "num_classes": len(class_names),
        "startup_error": startup_error,
    }


@app.get("/season-recs", response_model=SeasonRecsResponse)
def get_season_recs(season: str):
    if not SEASON_RECS_PATH.exists():
        raise HTTPException(404, f"season_recs.json not found at {SEASON_RECS_PATH}")

    with open(SEASON_RECS_PATH, encoding="utf-8") as f:
        recs = json.load(f)

    if season not in recs:
        raise HTTPException(400, f"Season '{season}' not found. Available: {list(recs.keys())}")

    data = recs[season]

    if rf_model and preprocessor:
        input_data = {
            "N": [data["avg_features"]["N"]],
            "P": [data["avg_features"]["P"]],
            "K": [data["avg_features"]["K"]],
            "Temperature": [data["avg_features"]["Temperature"]],
            "humidity": [data["avg_features"]["humidity"]],
            "pH": [data["avg_features"]["pH"]],
            "Rainfall": [data["avg_features"]["Rainfall"]],
            "Season": [season],
        }
        input_df = pd.DataFrame(input_data)
        x = preprocessor.transform(input_df)
        proba = rf_model.predict_proba(x)[0]
        model_probs = {cls: float(p) for cls, p in zip(class_names, proba)}
    else:
        model_probs = {}

    return SeasonRecsResponse(
        season=season,
        top_crops=data["top_crops"],
        count=data["count"],
        avg_features=data["avg_features"],
        model_probs=model_probs,
    )


@app.post("/predict", response_model=PredictionResponse)
def predict(features: CropFeatures) -> PredictionResponse:
    if rf_model is None or shap_explainer is None or preprocessor is None:
        raise HTTPException(status_code=503, detail=startup_error or "Model not loaded.")

    input_df = pd.DataFrame(
        {
            "N": [features.N],
            "P": [features.P],
            "K": [features.K],
            "Temperature": [features.temperature],
            "humidity": [features.humidity],
            "pH": [features.ph],
            "Rainfall": [features.rainfall],
            "Season": [features.Season],
        }
    )

    try:
        x = preprocessor.transform(input_df)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Preprocessing error: {e}")

    proba = rf_model.predict_proba(x)[0]
    best_idx = int(np.argmax(proba))
    recommended_crop = class_names[best_idx]
    confidence = float(proba[best_idx])

    prob_dict = {str(cls): float(p) for cls, p in zip(class_names, proba)}

    shap_vals_raw: Any = shap_explainer.shap_values(x)

    def extract_shap(sv: Any, idx: int) -> Any:
        try:
            if getattr(sv, "ndim", 0) == 3:
                return sv[0, :, idx]
            return sv[0]
        except Exception:
            return sv[idx][0] if type(sv) is list else sv[0]

    arr: Any = np.array(shap_vals_raw)
    class_shap_vals: Any = (
        extract_shap(arr, best_idx).tolist()
        if hasattr(arr, "tolist")
        else extract_shap(shap_vals_raw, best_idx)
    )

    shap_pairs: Any = [
        (encoded_feature_names[i], class_shap_vals[i])
        for i in range(min(len(encoded_feature_names), len(class_shap_vals)))
    ]
    shap_pairs.sort(key=lambda item: abs(item[1]), reverse=True)
    shap_pairs = shap_pairs[:5]

    shap_explanation = [{"feature": name, "weight": float(weight)} for name, weight in shap_pairs]

    mandi_data = fetch_mandi_prices(recommended_crop)

    return {
        "recommended_crop": recommended_crop,
        "confidence": confidence,
        "class_probabilities": prob_dict,
        "shap_explanation": shap_explanation,
        "market_prices": mandi_data.get("market_prices", []),
        "price_summary": mandi_data.get("price_summary"),
        "estimated_investment": float(mandi_data.get("estimated_investment", 0)),
        "estimated_profit": float(mandi_data.get("estimated_profit", 0)),
        "estimated_investment_per_acre": float(mandi_data.get("estimated_investment_per_acre", 0)),
        "estimated_profit_per_acre": float(mandi_data.get("estimated_profit_per_acre", 0)),
        "assumed_yield_quintal_per_acre": float(mandi_data.get("assumed_yield_quintal_per_acre", 10)),
        "market_insight": str(mandi_data.get("market_insight", "")),
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8001")),
        reload=os.getenv("UVICORN_RELOAD", "true").lower() == "true",
    )

