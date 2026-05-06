from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import parse, request

import numpy as np
import pandas as pd
import shap
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.preprocessing import OneHotEncoder

# -----------------------------
# PATH CONFIGURATION
# -----------------------------
ROOT_DIR = Path(__file__).resolve().parent

load_dotenv(dotenv_path=ROOT_DIR / ".env")

DATA_PATH = ROOT_DIR / "data" / "indian_agri_dataset_15k.csv"
SEASON_RECS_PATH = ROOT_DIR / "data" / "season_recs.json"

# -----------------------------
# FASTAPI APP
# -----------------------------
app = FastAPI(
    title="Crop Recommendation API",
    description="ML microservice for crop recommendation",
    version="1.0.0",
)

# -----------------------------
# CORS
# -----------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------
# MODELS
# -----------------------------
class CropFeatures(BaseModel):
    N: float
    P: float
    K: float
    temperature: float
    humidity: float = Field(..., ge=0, le=100)
    ph: float = Field(..., ge=0, le=14)
    rainfall: float = Field(..., ge=0)
    Season: str
    location: str | None = "India"

    @field_validator("temperature")
    @classmethod
    def validate_temperature(cls, v: float):
        if v < -10 or v > 60:
            raise ValueError("Temperature out of range")
        return v


class PredictionResponse(BaseModel):
    recommended_crop: str
    confidence: float
    class_probabilities: Dict[str, float]
    shap_explanation: List[Dict[str, Any]]
    market_insight: str = ""


# -----------------------------
# GLOBAL VARIABLES
# -----------------------------
rf_model = None
shap_explainer = None
preprocessor = None
class_names = []

feature_names = [
    "N",
    "P",
    "K",
    "Temperature",
    "humidity",
    "pH",
    "Rainfall",
    "Season",
]

encoded_feature_names = []

startup_error = None

# -----------------------------
# CROP MAPPING
# -----------------------------
CROP_TO_COMMODITY = {
    "rice": "Rice",
    "maize": "Maize",
    "banana": "Banana",
    "mango": "Mango",
    "cotton": "Cotton",
    "coffee": "Coffee",
}

DATA_GOV_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"

# -----------------------------
# MANDI PRICE FETCH
# -----------------------------
def fetch_mandi_prices(crop: str):

    api_key = os.getenv("DATA_GOV_API_KEY", "")

    if not api_key:
        return {
            "market_insight": "DATA_GOV_API_KEY not configured."
        }

    crop_key = crop.lower().strip()

    commodity = CROP_TO_COMMODITY.get(
        crop_key,
        crop.title()
    )

    try:
        url = (
            f"https://api.data.gov.in/resource/{DATA_GOV_RESOURCE_ID}"
            f"?api-key={parse.quote(api_key)}"
            f"&format=json"
            f"&limit=5"
            f"&filters[commodity]={parse.quote(commodity)}"
        )

        req = request.Request(
            url,
            headers={"User-Agent": "crop-app"}
        )

        with request.urlopen(req, timeout=20) as response:
            payload = json.loads(
                response.read().decode("utf-8")
            )

        records = payload.get("records", [])

        if not records:
            return {
                "market_insight": f"No mandi data found for {commodity}"
            }

        prices = []

        for rec in records:
            try:
                prices.append(
                    float(rec.get("modal_price", 0))
                )
            except:
                pass

        if not prices:
            return {
                "market_insight": f"No valid market prices for {commodity}"
            }

        avg_price = round(sum(prices) / len(prices), 2)

        return {
            "market_insight": (
                f"{commodity} average mandi price: "
                f"Rs {avg_price}/quintal"
            )
        }

    except Exception as e:
        print("Mandi API Error:", e)

        return {
            "market_insight": "Unable to fetch mandi prices."
        }


# -----------------------------
# TRAIN MODEL
# -----------------------------
def load_and_train_model():

    global rf_model
    global shap_explainer
    global preprocessor
    global class_names
    global encoded_feature_names

    if not DATA_PATH.exists():
        raise RuntimeError(
            f"Dataset not found: {DATA_PATH}"
        )

    df = pd.read_csv(DATA_PATH)

    if "Humidity" in df.columns:
        df.rename(
            columns={"Humidity": "humidity"},
            inplace=True
        )

    X = df[feature_names]

    y = df["Crop"].astype(str)

    categorical_features = ["Season"]

    numeric_features = [
        "N",
        "P",
        "K",
        "Temperature",
        "humidity",
        "pH",
        "Rainfall",
    ]

    preprocessor_obj = ColumnTransformer(
        transformers=[
            (
                "num",
                "passthrough",
                numeric_features
            ),
            (
                "cat",
                OneHotEncoder(
                    handle_unknown="ignore",
                    sparse_output=False
                ),
                categorical_features
            ),
        ]
    )

    X_encoded = preprocessor_obj.fit_transform(X)

    rf = RandomForestClassifier(
        n_estimators=300,
        random_state=42,
        n_jobs=-1
    )

    rf.fit(X_encoded, y)

    rf_model = rf

    shap_explainer = shap.TreeExplainer(rf)

    preprocessor = preprocessor_obj

    class_names = list(rf.classes_)

    encoded_feature_names = (
        numeric_features
        + list(
            preprocessor_obj.named_transformers_["cat"]
            .get_feature_names_out(categorical_features)
        )
    )


# -----------------------------
# STARTUP
# -----------------------------
@app.on_event("startup")
def startup_event():

    global startup_error

    try:
        load_and_train_model()

        startup_error = None

    except Exception as e:
        startup_error = str(e)

        print("Startup Error:", e)


# -----------------------------
# HEALTH ROUTE
# -----------------------------
@app.get("/")
def root():
    return {
        "message": "Crop Recommendation API Running"
    }


@app.get("/health")
def health():

    return {
        "status": "ok",
        "model_ready": rf_model is not None,
        "startup_error": startup_error,
    }


# -----------------------------
# PREDICT ROUTE
# -----------------------------
@app.post(
    "/predict",
    response_model=PredictionResponse
)
def predict(features: CropFeatures):

    if (
        rf_model is None
        or shap_explainer is None
        or preprocessor is None
    ):
        raise HTTPException(
            status_code=503,
            detail=startup_error or "Model not loaded"
        )

    input_df = pd.DataFrame({
        "N": [features.N],
        "P": [features.P],
        "K": [features.K],
        "Temperature": [features.temperature],
        "humidity": [features.humidity],
        "pH": [features.ph],
        "Rainfall": [features.rainfall],
        "Season": [features.Season],
    })

    try:
        x = preprocessor.transform(input_df)

    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Preprocessing error: {e}"
        )

    proba = rf_model.predict_proba(x)[0]

    best_idx = int(np.argmax(proba))

    recommended_crop = class_names[best_idx]

    confidence = float(proba[best_idx])

    prob_dict = {
        str(cls): float(p)
        for cls, p in zip(class_names, proba)
    }

    shap_values = shap_explainer.shap_values(x)

    try:
        class_shap_vals = shap_values[best_idx][0]

    except:
        class_shap_vals = shap_values[0]

    shap_pairs = []

    for i in range(
        min(
            len(encoded_feature_names),
            len(class_shap_vals)
        )
    ):
        shap_pairs.append(
            (
                encoded_feature_names[i],
                class_shap_vals[i]
            )
        )

    shap_pairs.sort(
        key=lambda item: abs(item[1]),
        reverse=True
    )

    shap_pairs = shap_pairs[:5]

    shap_explanation = [
        {
            "feature": name,
            "weight": float(weight)
        }
        for name, weight in shap_pairs
    ]

    mandi_data = fetch_mandi_prices(
        recommended_crop
    )

    return {
        "recommended_crop": recommended_crop,
        "confidence": confidence,
        "class_probabilities": prob_dict,
        "shap_explanation": shap_explanation,
        "market_insight": mandi_data.get(
            "market_insight",
            ""
        ),
    }


# -----------------------------
# MAIN
# -----------------------------
if __name__ == "__main__":

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "10000")),
    )
