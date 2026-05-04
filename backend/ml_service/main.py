from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List
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

try:
    from google import genai  # type: ignore
except ModuleNotFoundError:
    genai = None  # type: ignore

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


class PredictionResponse(BaseModel):
    recommended_crop: str
    confidence: float
    class_probabilities: Dict[str, float]
    shap_explanation: List[Dict[str, Any]]
    estimated_investment: Any = None
    estimated_profit: Any = None
    market_insight: str | None = None


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


def fetch_agmarket_data(crop: str, location: str) -> Dict[str, Any] | None:
    base_url = os.getenv("AGMARKET_API_URL")
    if not base_url:
        return None

    api_key = os.getenv("AGMARKET_API_KEY")
    api_key_header = os.getenv("AGMARKET_API_KEY_HEADER", "x-api-key")

    try:
        formatted_url = base_url.format(crop=parse.quote(crop), location=parse.quote(location))
        req = request.Request(formatted_url)
        if api_key:
            req.add_header(api_key_header, api_key)

        with request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))

        record = None
        if isinstance(payload, dict):
            records = payload.get("records")
            if isinstance(records, list) and records:
                record = records[0]

        source_obj = record if isinstance(record, dict) else payload
        return {
            "source": "agmarket",
            "crop": crop,
            "location": location,
            "min_price": source_obj.get("min_price") or source_obj.get("min") or source_obj.get("minimum_price"),
            "max_price": source_obj.get("max_price") or source_obj.get("max") or source_obj.get("maximum_price"),
            "modal_price": source_obj.get("modal_price") or source_obj.get("modal"),
            "market": source_obj.get("market"),
            "state": source_obj.get("state"),
            "district": source_obj.get("district"),
            "variety": source_obj.get("variety"),
            "arrival_date": source_obj.get("arrival_date"),
            "raw": payload,
        }
    except (error.URLError, json.JSONDecodeError, KeyError, ValueError) as e:
        print(f"WARN - AgMarket fetch failed: {e}")
        return None


def get_financial_estimates(crop: str, location: str) -> dict:
    api_key = os.getenv("GEMINI_API_KEY")

    fallbacks = {
        "rice": {"investment": 25000, "profit": 35000},
        "maize": {"investment": 18000, "profit": 21000},
        "chickpea": {"investment": 12000, "profit": 8000},
        "kidneybeans": {"investment": 15000, "profit": 10000},
        "pigeonpeas": {"investment": 14000, "profit": 9000},
        "mothbeans": {"investment": 10000, "profit": 6000},
        "mungbean": {"investment": 11000, "profit": 7000},
        "blackgram": {"investment": 11500, "profit": 7500},
        "lentil": {"investment": 12000, "profit": 8000},
        "pomegranate": {"investment": 40000, "profit": 30000},
        "banana": {"investment": 35000, "profit": 25000},
        "mango": {"investment": 30000, "profit": 20000},
        "grapes": {"investment": 45000, "profit": 35000},
        "watermelon": {"investment": 20000, "profit": 15000},
        "muskmelon": {"investment": 18000, "profit": 12000},
        "apple": {"investment": 50000, "profit": 40000},
        "orange": {"investment": 35000, "profit": 25000},
        "papaya": {"investment": 25000, "profit": 18000},
        "coconut": {"investment": 20000, "profit": 15000},
        "cotton": {"investment": 30000, "profit": 20000},
        "jute": {"investment": 22000, "profit": 14000},
        "coffee": {"investment": 40000, "profit": 25000},
    }

    def estimate_without_llm() -> dict:
        crop_key = str(crop).strip().lower()
        inv = fallbacks.get(crop_key, {"investment": 20000})["investment"]
        prof = fallbacks.get(crop_key, {"profit": 10000})["profit"]
        return {
            "investment": inv,
            "profit": prof,
            "insight": f"Market outlook for {crop} in {location} appears stable with moderate return potential.",
        }

    if not api_key:
        return estimate_without_llm()

    try:
        if genai is None:
            raise ImportError("Google GenAI SDK is not installed or failed to import.")

        client = genai.Client(api_key=api_key)
        market_data = fetch_agmarket_data(crop, location)
        market_context = json.dumps(market_data, ensure_ascii=True) if market_data else "No AgMarket data available."

        prompt = f"""
You are an agriculture expert.
Estimate per-acre investment and profit for {crop} in {location} (India).
Use this AgMarket context when available:
{market_context}
Return ONLY JSON:
{{"investment": 25000, "profit": 15000, "insight": "short explanation"}}
"""

        response = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
        text = (response.text or "").replace("```json", "").replace("```", "").strip()
        if not text:
            raise ValueError("Empty response text from model")
        return json.loads(text)
    except Exception:
        return estimate_without_llm()


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

    location = features.location or "India"
    financials = get_financial_estimates(recommended_crop, location)

    return {
        "recommended_crop": recommended_crop,
        "confidence": confidence,
        "class_probabilities": prob_dict,
        "shap_explanation": shap_explanation,
        "estimated_investment": financials.get("investment"),
        "estimated_profit": financials.get("profit"),
        "market_insight": financials.get("insight"),
    }


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8001")),
        reload=os.getenv("UVICORN_RELOAD", "true").lower() == "true",
    )

