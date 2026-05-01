from backend.main import predict, CropFeatures, load_and_train_model
load_and_train_model()
features = CropFeatures(N=90, P=42, K=43, temperature=20.8, humidity=82.0, ph=6.5, rainfall=202.9, Season='Kharif')
print(predict(features))
