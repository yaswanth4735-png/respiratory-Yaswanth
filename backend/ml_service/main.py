from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List
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
BACKEND_DIR = ROOT_DIR.parent
PROJECT_DIR = BACKEND_DIR.parent

load_dotenv(dotenv_path=PROJECT_DIR / ".env")

DATA_PATH = BACKEND_DIR / "data" / "indian_agri_dataset_15k.csv"

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
# REQUEST / RESPONSE MODELS
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
    market_prices: List[Dict[str, Any]] = []
    price_summary: Dict[str, Any] = {}


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
# CROP COMMODITY MAPPING
# -----------------------------
CROP_TO_COMMODITY = {
    "rice": ["Rice", "Paddy", "Paddy(Dhan)(Common)"],
    "maize": ["Makka", "Maize", "Corn"],
    "chickpea": ["Gram", "Bengal Gram"],
    "kidneybeans": ["Rajma"],
    "pigeonpeas": ["Arhar", "Tur"],
    "mungbean": ["Moong", "Green Gram"],
    "blackgram": ["Urd", "Black Gram"],
    "lentil": ["Masur", "Lentil"],
    "banana": ["Banana"],
    "mango": ["Mango"],
    "grapes": ["Grapes"],
    "apple": ["Apple"],
    "orange": ["Orange"],
    "papaya": ["Papaya"],
    "cotton": ["Cotton"],
    "jute": ["Jute"],
    "coffee": ["Coffee"],
}

DATA_GOV_RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"

# -----------------------------
# FETCH MANDI PRICES
# -----------------------------
def fetch_mandi_prices(crop: str):

    api_key = os.getenv("DATA_GOV_API_KEY", "")

    if not api_key:
        return {
            "market_insight":
            "DATA_GOV_API_KEY not configured.",
            "market_prices": [],
            "price_summary": {}
        }

    crop_key = crop.lower().strip()

    possible_commodities = CROP_TO_COMMODITY.get(
        crop_key,
        [crop.title()]
    )

    try:

        for commodity in possible_commodities:

            print(f"Trying commodity: {commodity}")

            url = (
                f"https://api.data.gov.in/resource/{DATA_GOV_RESOURCE_ID}"
                f"?api-key={parse.quote(api_key)}"
                f"&format=json"
                f"&limit=50"
                f"&filters[commodity]={parse.quote(commodity)}"
            )

            req = request.Request(
                url,
                headers={
                    "User-Agent": "crop-app"
                }
            )

            with request.urlopen(req, timeout=30) as response:

                payload = json.loads(
                    response.read().decode("utf-8")
                )

            records = payload.get("records", [])

            print("Records found:", len(records))

            if not records:
                continue

            prices = []

            markets = []

            for rec in records:

                try:

                    modal_price = float(
                        rec.get("modal_price", 0)
                    )

                    market = rec.get("market", "")

                    if modal_price > 0:

                        prices.append(modal_price)

                        if market:
                            markets.append(market)

                except Exception as e:

                    print("Price parse error:", e)

            if not prices:
                continue

            avg_price = round(
                sum(prices) / len(prices),
                2
            )

            min_price = round(min(prices), 2)

            max_price = round(max(prices), 2)

            unique_markets = list(set(markets))

            top_markets = ", ".join(
                unique_markets[:5]
            )

            return {
                "market_insight":
                (
                    f"{commodity} mandi prices "
                    f"(data.gov.in) -> "
                    f"Avg: Rs {avg_price}/quintal | "
                    f"Min: Rs {min_price} | "
                    f"Max: Rs {max_price} | "
                    f"Markets: {top_markets}"
                ),
                "market_prices": records,
                "price_summary": {
                    "min_price": min_price,
                    "max_price": max_price,
                    "avg_modal_price": avg_price
                }
            }

        return {
            "market_insight":
            (
                f"No live mandi data found for "
                f"{crop.title()} today."
            ),
            "market_prices": [],
            "price_summary": {}
        }

    except Exception as e:

        print("MANDI API ERROR:", str(e))

        return {
            "market_insight":
            "Unable to fetch mandi prices.",
            "market_prices": [],
            "price_summary": {}
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
            preprocessor_obj
            .named_transformers_["cat"]
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

        print("Model loaded successfully")

    except Exception as e:

        startup_error = str(e)

        print("STARTUP ERROR:", e)


# -----------------------------
# ROOT
# -----------------------------
@app.get("/")
def root():

    return {
        "message":
        "Crop Recommendation API Running"
    }


# -----------------------------
# HEALTH
# -----------------------------
@app.api_route("/health",maethods=["GET","HEAD"])

def health():

    return {
        "status": "ok",
        "model_ready": rf_model is not None,
        "startup_error": startup_error,
    }


# -----------------------------
# PREDICT
# -----------------------------
@app.post(
    "/predict",
    response_model=PredictionResponse
)
def predict(features: CropFeatures):

    if (
        rf_model is None
        or preprocessor is None
    ):

        raise HTTPException(
            status_code=503,
            detail=startup_error or "Model not loaded"
        )

    try:

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

        x = preprocessor.transform(input_df)

        proba = rf_model.predict_proba(x)[0]

        best_idx = int(np.argmax(proba))

        recommended_crop = class_names[best_idx]

        confidence = float(proba[best_idx])

        prob_dict = {
            str(cls): float(p)
            for cls, p in zip(class_names, proba)
        }

        # -----------------------------
        # SHAP EXPLANATION
        # -----------------------------
        shap_explanation = []

        try:

            if shap_explainer is not None:

                shap_values = shap_explainer.shap_values(x)

                shap_array = np.array(shap_values)

                if shap_array.ndim == 3:

                    class_shap_vals = shap_array[0, :, best_idx]

                elif shap_array.ndim == 2:

                    class_shap_vals = shap_array[0]

                else:

                    class_shap_vals = shap_array.flatten()

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
                            float(class_shap_vals[i])
                        )
                    )

                shap_pairs.sort(
                    key=lambda item: abs(item[1]),
                    reverse=True
                )

                shap_pairs = shap_pairs[:5]

                shap_explanation = [
                    {
                        "feature": feature,
                        "weight": weight
                    }
                    for feature, weight in shap_pairs
                ]

        except Exception as shap_error:

            print("SHAP ERROR:", str(shap_error))

            shap_explanation = []

        # -----------------------------
        # MANDI PRICE FETCH
        # -----------------------------
        mandi_data = fetch_mandi_prices(
            recommended_crop
        )

        market_insight = mandi_data.get(
            "market_insight",
            ""
        )
        market_prices = mandi_data.get("market_prices", [])
        price_summary = mandi_data.get("price_summary", {})

        # -----------------------------
        # RESPONSE
        # -----------------------------
        return {
            "recommended_crop": recommended_crop,
            "confidence": confidence,
            "class_probabilities": prob_dict,
            "shap_explanation": shap_explanation,
            "market_insight": market_insight,
            "market_prices": market_prices,
            "price_summary": price_summary,
        }

    except Exception as e:

        print("PREDICT ERROR:", str(e))

        raise HTTPException(
            status_code=500,
            detail=str(e)
        )


# -----------------------------
# MAIN
# -----------------------------
if __name__ == "__main__":

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "10000")),
    )
