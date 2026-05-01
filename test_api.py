import urllib.request, json, urllib.error
data = json.dumps({'N': 90, 'P': 42, 'K': 43, 'temperature': 20.8, 'humidity': 82.0, 'ph': 6.5, 'rainfall': 202.9, 'Season': 'Kharif'}).encode('utf-8')
req = urllib.request.Request('http://127.0.0.1:8001/predict', data=data, headers={'Content-Type': 'application/json'})
try:
    print(urllib.request.urlopen(req).read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print("ERROR:", e.read().decode('utf-8'))
