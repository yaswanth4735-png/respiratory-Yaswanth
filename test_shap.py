import sys
from pathlib import Path

# Add backend directory to sys.path so we can import from it
backend_dir = Path(r"d:\OneDrive\Documents\crop recommendation\crop recommendation\backend")
sys.path.append(str(backend_dir))

import main
from main import CropFeatures, predict

print("Loading model...")
main.load_and_train_model()
print("Model loaded.")

features = CropFeatures(
    N=90,
    P=42,
    K=43,
    temperature=20.8,
    humidity=82.0,
    ph=6.5,
    rainfall=202.9
)

print("Predicting...")
response = predict(features)

print("Recommended Crop:", response.recommended_crop)
print("Confidence:", response.confidence)
print("SHAP explanation type:", type(response.shap_explanation))
print("SHAP feature weights:")
for item in response.shap_explanation:
    print(f"  {item['feature']}: {item['weight']}")

print("Test passed.")
