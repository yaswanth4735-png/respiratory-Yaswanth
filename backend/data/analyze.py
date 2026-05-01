import pandas as pd
import sys

def analyze():
    filepath = 'd:/OneDrive/Documents/crop recommendation/crop recommendation/backend/data/crop_recommendation.csv'
    try:
        df = pd.read_csv(filepath)
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
        return

    print("--- INFO ---")
    df.info()
    
    print("\n--- NULLS ---")
    print(df.isnull().sum())
    
    print("\n--- COLUMNS ---")
    print(df.columns.tolist())
    
    print("\n--- CATEGORICAL UNIQUE COUNTS ---")
    for col in df.select_dtypes(include=['object']).columns:
        print(f"{col}: {df[col].nunique()} unique values")
        print(df[col].value_counts().head())
        print()

    print("\n--- DESCRIBE NUMERICS ---")
    print(df.describe())

if __name__ == "__main__":
    analyze()
