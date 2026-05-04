# Crop Recommendation (Frontend Prototype)

This folder contains a simple **HTML/CSS/JS** frontend for a crop recommendation system UI, plus a separate **Login/Sign‑up** page and an **About** page.

## Pages

- `index.html`: Main crop recommendation UI (inputs + results panel)
- `login.html`: Separate login / sign‑up page
- `about.html`: Project and tech stack description

## Tech stack (as specified)

1. **Python**: backend programming
2. **Random Forest**: ML algorithm for crop recommendation
3. **SHAP**: explainable AI (local explanations / feature contributions)
4. **Pandas, NumPy**: data manipulation
5. **HTML, CSS, JS**: user interface (this repo part)

## Run the frontend

From this folder:

```bash
python -m http.server 8000
```

Then open:

- `http://localhost:8000/index.html`
- `http://localhost:8000/login.html`
- `http://localhost:8000/about.html`

## Backend hookup (next step)

The frontend is now **connected** to the backend. When you submit the form on `index.html`, it calls:

- `POST http://localhost:8001/predict`

A simple FastAPI backend is scaffolded in `../ml_service/main.py`:

- Random Forest model trained on the Kaggle crop recommendation dataset
- SHAP explanations for each prediction

To run the backend (after placing `indian_agri_dataset_15k.csv` into `backend/data/`):

```bash
pip install -r backend/ml_service/requirements.txt
uvicorn backend.ml_service.main:app --reload --port 8001
```

Key endpoints:

- `GET /health` – check model status
- `POST /predict` – send JSON with `N, P, K, temperature, humidity, ph, rainfall` and receive crop prediction + SHAP explanation


