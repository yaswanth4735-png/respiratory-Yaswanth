import sys
import traceback
sys.path.insert(0, '.')
from backend.main import load_and_train_model, predict, CropFeatures

try:
    load_and_train_model()
    predict(CropFeatures(N=90, P=42, K=43, temperature=20, humidity=82, ph=6.5, rainfall=120, Season='Kharif'))
except Exception as e:
    with open('backend/error.txt', 'w') as f:
        traceback.print_exc(file=f)
