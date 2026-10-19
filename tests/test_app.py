import csv
import http.cookiejar
import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class Client:
    def __init__(self, base):
        self.base, self.csrf = base, ''
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, method='GET', data=None, csrf=True, origin=None):
        headers = {'Content-Type': 'application/json'}
        if csrf:
            headers['X-CSRF-Token'] = self.csrf
        if origin:
            headers['Origin'] = origin
        req = urllib.request.Request(self.base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
        try:
            response = self.opener.open(req, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        content = response.read()
        result = json.loads(content) if response.headers.get('Content-Type', '').startswith('application/json') else content
        return response.status, result, response.headers

    def sync(self):
        status, result, _ = self.request('/api/state')
        if status == 200:
            self.csrf = result['csrf']
        return status, result


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        server.DB_PATH = Path(self.temp.name) / 'journal.db'
        server.SETUP_TOKEN = 'isolated-test-setup-token-with-enough-entropy'
        server.COOKIE_SECURE = False
        server.PUBLIC_ORIGIN = ''
        server.initialize()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.http.daemon_threads = True
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.http.server_address[1]}'
        self.owner, self.viewer = Client(self.base), Client(self.base)
        self.day = server.today().isoformat()
        self.start = (server.today() - timedelta(days=2)).isoformat()
        status, _, _ = self.owner.request('/api/setup', 'POST', {
            'token': server.SETUP_TOKEN, 'owner_username': 'recorder', 'owner_name': '记录者',
            'owner_password': ' secure owner password ', 'viewer_username': 'partner',
            'viewer_name': '陪伴者', 'viewer_password': 'secure viewer password', 'start_date': self.start})
        self.assertEqual(status, 200)
        self.owner.sync()
        self.viewer.request('/api/login', 'POST', {'username': 'partner', 'password': 'secure viewer password'})
        self.viewer.sync()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        self.temp.cleanup()

    def save(self, **kwargs):
        payload = {'weight': 81.25, 'note': '散步半小时', 'version': 0, **kwargs}
        return self.owner.request('/api/records/' + self.day, 'PUT', payload)

    def test_setup_atomic_and_initial_records_empty(self):
        self.assertEqual(self.owner.sync()[1]['records'], [])
        status, _, _ = self.owner.request('/api/setup', 'POST', {'token': server.SETUP_TOKEN})
        self.assertEqual(status, 409)
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM users').fetchone()[0], 2)
            self.assertNotIn('secure owner password', db.execute('SELECT password FROM users LIMIT 1').fetchone()[0])

    def test_authentication_and_logout(self):
        outsider = Client(self.base)
        for route in ['/api/state', '/api/export.csv', '/api/backup.json']:
            self.assertEqual(outsider.request(route)[0], 401)
        self.assertEqual(outsider.request('/api/login', 'POST', {'username': 'recorder', 'password': ' secure owner password '})[0], 200)
        outsider.sync()
        self.assertEqual(outsider.request('/api/logout', 'POST', {})[0], 200)
        self.assertEqual(outsider.request('/api/state')[0], 401)

    def test_viewer_reads_but_cannot_modify(self):
        self.assertEqual(self.save()[0], 200)
        self.assertEqual(self.viewer.sync()[1]['records'][0]['weight'], 81.25)
        self.assertEqual(self.viewer.request('/api/records/' + self.day, 'PUT', {'weight': 75, 'version': 1})[0], 403)
        self.assertEqual(self.viewer.request('/api/records/' + self.day, 'DELETE', {'version': 1})[0], 403)
        self.assertEqual(self.viewer.request('/api/plan', 'PUT', {'start_date': self.start, 'version': 1})[0], 403)
        self.assertEqual(self.viewer.request('/api/backup.json')[0], 403)
        self.assertEqual(self.viewer.request('/api/export.csv')[0], 200)

    def test_comments_shared_and_plain_text(self):
        comment = '<script>alert(1)</script> 加油🌿'
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': comment})[0], 200)
        data = self.owner.sync()[1]
        self.assertEqual(data['comments'][0]['text'], comment)
        self.assertEqual(data['comments'][0]['name'], '陪伴者')
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': ''})[0], 400)
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': 'x' * 501})[0], 400)

    def test_record_conflict_and_delete(self):
        self.assertEqual(self.save()[0], 200)
        self.assertEqual(self.save(weight=80)[0], 409)
        self.assertEqual(self.save(weight=80, version=1)[0], 200)
        self.assertEqual(self.owner.request('/api/records/' + self.day, 'DELETE', {'version': 1})[0], 409)
        self.assertEqual(self.owner.request('/api/records/' + self.day, 'DELETE', {'version': 2})[0], 200)
        self.assertEqual(self.owner.sync()[1]['records'], [])

    def test_invalid_weight_and_missing_not_zero(self):
        for value in [None, 0, -1, True, '81', 501, float('nan'), float('inf')]:
            with self.subTest(value=value):
                self.assertEqual(self.save(weight=value)[0], 400)
        self.assertEqual(self.owner.sync()[1]['records'], [])

    def test_date_boundaries(self):
        for day in ['2026-02-30', '2026-1-1', (server.today() + timedelta(days=1)).isoformat(), (server.today() - timedelta(days=3)).isoformat()]:
            with self.subTest(day=day):
                self.assertEqual(self.owner.request('/api/records/' + day, 'PUT', {'weight': 80, 'version': 0})[0], 400)
        self.assertEqual(self.owner.request('/api/records/' + self.start, 'PUT', {'weight': 82, 'version': 0})[0], 200)

    def test_csrf_and_origin(self):
        self.assertEqual(self.owner.request('/api/comments', 'POST', {'text': 'hello'}, csrf=False)[0], 403)
        self.assertEqual(self.owner.request('/api/comments', 'POST', {'text': 'hello'}, origin='https://attacker.example')[0], 403)
        self.assertEqual(self.owner.request('/api/comments', 'POST', {'text': 'hello'}, origin=self.base)[0], 200)

    def test_plan_conflict_and_record_preservation(self):
        self.save()
        self.assertEqual(self.owner.request('/api/plan', 'PUT', {'start_date': self.start, 'goal_weight': None, 'version': 1})[0], 200)
        self.assertEqual(self.owner.request('/api/plan', 'PUT', {'start_date': self.start, 'goal_weight': 75, 'version': 1})[0], 409)
        self.assertEqual(self.owner.request('/api/plan', 'PUT', {'start_date': (server.today() + timedelta(days=1)).isoformat(), 'version': 2})[0], 400)

    def test_csv_export_and_formula_injection(self):
        self.save(note='=HYPERLINK("https://example.com")')
        code, raw, headers = self.owner.request('/api/export.csv')
        self.assertEqual(code, 200)
        rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 101)
        self.assertEqual(rows[0], ['日期', '体重(kg)', '备注'])
        self.assertTrue(rows[3][2].startswith("'="))
        self.assertEqual(rows[4][1], '')
        self.assertIn('attachment', headers['Content-Disposition'])

    def test_persistence_and_backup(self):
        self.save()
        server.initialize()
        self.assertEqual(self.owner.sync()[1]['records'][0]['weight'], 81.25)
        backup = server.make_backup()
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('SELECT weight FROM records').fetchone()[0], 81.25)
        code, data, _ = self.owner.request('/api/backup.json')
        self.assertEqual(code, 200)
        self.assertIn('records', data)
        self.assertNotIn('password', json.dumps(data))
        self.assertNotIn('csrf', data)

    def test_password_change_revokes_other_sessions(self):
        second = Client(self.base)
        second.request('/api/login', 'POST', {'username': 'partner', 'password': 'secure viewer password'})
        second.sync()
        self.assertEqual(self.viewer.request('/api/password', 'POST', {'current': 'secure viewer password', 'password': 'another secure password'})[0], 200)
        self.assertEqual(second.request('/api/state')[0], 401)
        self.assertEqual(self.viewer.request('/api/state')[0], 200)

    def test_login_throttle_persists_failed_attempts(self):
        for _ in range(12):
            self.assertEqual(self.owner.request('/api/login', 'POST', {'username': 'missing', 'password': 'wrong'})[0], 401)
        self.assertEqual(self.owner.request('/api/login', 'POST', {'username': 'missing', 'password': 'wrong'})[0], 429)

    def test_static_path_and_security_headers(self):
        client = Client(self.base)
        for route in ['/.env', '/server.py', '/data/journal.db', '/static/../server.py']:
            self.assertEqual(client.request(route)[0], 404)
        code, data, headers = client.request('/')
        self.assertEqual(code, 200)
        self.assertIn(b'app.js', data)
        self.assertIn("script-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(headers['X-Frame-Options'], 'DENY')


if __name__ == '__main__':
    unittest.main()
