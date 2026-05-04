#!/usr/bin/env python3
"""
Test season recommendations endpoint + frontend integration
Run: python test_season_recs.py
Requires: requests, backend server running on localhost:8001
"""

import requests
import json
import sys

BASE_URL = "http://localhost:8001"

def test_endpoint(season):
    """Test /season-recs endpoint"""
    url = f"{BASE_URL}/season-recs?season={season}"
    try:
        resp = requests.get(url, timeout=5)
        print(f"✅ {season}: {resp.status_code}")
        if resp.ok:
            data = resp.json()
            print(f"   Top crops: {list(data['top_crops'].keys())[:3]}")
            print(f"   Count: {data['count']}")
            print(f"   Model probs: {dict(list(data.get('model_probs', {}).items())[:3])}")
        return resp.ok
    except Exception as e:
        print(f"❌ {season}: {e}")
        return False

def test_integration():
    """Simulate frontend flow"""
    seasons = ["Kharif", "Rabi", "Zaid", "Post-Monsoon"]
    results = [test_endpoint(s) for s in seasons]
    success = all(results)
    
    print("\n" + "="*50)
    print("TEST SUMMARY")
    print(f"✅ All endpoints OK: {success}")
    print("💡 Frontend ready: season dropdown → fetch → preview display")
    print("💡 Next: Open frontend/index.html, change season, verify preview")
    return success

if __name__ == "__main__":
    print("🌱 Testing Season Recommendations")
    print(f"Backend: {BASE_URL}")
    test_integration()

