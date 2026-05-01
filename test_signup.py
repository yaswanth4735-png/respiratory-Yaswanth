import traceback
try:
    from backend.main import signup, SignupData
    data = SignupData(email='test4@example.com', password='pwd', firstName='test', lastName='user')
    print(signup(data))
except Exception as e:
    traceback.print_exc()
