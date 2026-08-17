from server.app import app
from server import db
db.init_db(reset=True)

with app.test_client() as c:
    # Register a passenger
    r = c.post('/api/auth/register', json={'name':'Test','phone':'08011111111','password':'pass1234','role':'passenger'})
    assert r.status_code == 201, f'Register failed: {r.status_code} {r.data}'
    print('Register OK')

    # Login
    r = c.post('/api/auth/login', json={'phone':'08011111111','password':'pass1234'})
    assert r.status_code == 200, f'Login failed: {r.status_code} {r.data}'
    print('Login OK')

    uid = r.get_json()['token']
    headers = {'X-User-Id': str(uid)}

    # Send support message
    r = c.post('/api/messages', json={'content':'Hello support','conversation_type':'support'}, headers=headers)
    assert r.status_code == 201, f'Send message failed: {r.status_code} {r.data}'
    data = r.get_json()
    assert data.get('bot_reply'), 'No bot reply'
    br = data['bot_reply']['content']
    print(f'Chat OK - bot replied: {br[:60]}')

    # Get messages
    r = c.get('/api/messages', headers=headers)
    assert r.status_code == 200
    msgs = r.get_json()
    print(f'Get messages OK - {len(msgs)} messages')

    # Admin CRUD
    r = c.post('/api/auth/login', json={'phone':'07000000000','password':'admin123'})
    admin_uid = r.get_json()['token']
    ah = {'X-User-Id': str(admin_uid)}

    # List users
    r = c.get('/api/admin/users', headers=ah)
    users = r.get_json()
    print(f'Admin users OK - {len(users)} users')

    # Edit user
    r = c.put(f'/api/admin/users/{uid}', json={'name':'Updated Name'}, headers=ah)
    assert r.status_code == 200
    print('Admin edit user OK')

    # Delete user
    r = c.delete(f'/api/admin/users/{uid}', headers=ah)
    assert r.status_code == 200
    print('Admin delete user OK')

print('ALL INTEGRATION TESTS PASSED')
