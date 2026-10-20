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

    def seed_chat(self, user_ids):
        with server.connect() as db:
            for user_id in user_ids:
                db.execute('INSERT INTO comments(user_id,text,created_at) VALUES(?,?,?)',
                           (user_id, 'isolated test message', server.now()))

    def test_unread_counts_only_partner_and_state_fetch_does_not_read(self):
        self.seed_chat([1, 2, 2])
        for _ in range(2):
            owner = self.owner.sync()[1]
            viewer = self.viewer.sync()[1]
            self.assertEqual(owner['chat'], {'unread_count': 2, 'last_read_id': 0, 'partner_last_read_id': 0})
            self.assertEqual(viewer['chat']['unread_count'], 1)
        self.assertEqual(self.owner.request('/api/comments')[0], 200)
        self.assertEqual(self.owner.sync()[1]['chat']['unread_count'], 2)

    def test_read_cursor_is_per_user_persistent_and_monotonic(self):
        self.seed_chat([1, 2, 2])
        status, result, _ = self.viewer.request('/api/comments/read', 'POST', {'last_read_id': 1, 'user_id': 1})
        self.assertEqual(status, 200)
        self.assertEqual(result['chat']['unread_count'], 0)
        self.assertEqual(self.owner.sync()[1]['chat']['partner_last_read_id'], 1)
        self.assertEqual(self.owner.sync()[1]['chat']['last_read_id'], 0)
        self.assertEqual(self.owner.request('/api/comments/read', 'POST', {'last_read_id': 3})[0], 200)
        self.owner.request('/api/comments/read', 'POST', {'last_read_id': 1})
        server.initialize()  # Startup migrations are repeatable and preserve receipts.
        self.assertEqual(self.owner.sync()[1]['chat']['last_read_id'], 3)
        self.assertEqual(self.viewer.sync()[1]['chat']['partner_last_read_id'], 3)
        self.assertEqual(self.owner.sync()[1]['chat']['unread_count'], 0)

    def test_read_old_snapshot_does_not_consume_newer_message(self):
        self.seed_chat([2, 1])
        shown_id = self.owner.sync()[1]['comments'][-1]['id']
        self.seed_chat([2])
        status, result, _ = self.owner.request('/api/comments/read', 'POST', {'last_read_id': shown_id})
        self.assertEqual(status, 200)
        self.assertEqual(result['chat']['unread_count'], 1)
        self.assertEqual(result['chat']['last_read_id'], 2)

    def test_read_requires_login_csrf_and_valid_existing_integer_cursor(self):
        outsider = Client(self.base)
        self.seed_chat([2])
        self.assertEqual(outsider.request('/api/comments/read', 'POST', {'last_read_id': 1})[0], 401)
        self.assertEqual(self.owner.request('/api/comments/read', 'POST', {'last_read_id': 1}, csrf=False)[0], 403)
        for value in [-1, 2, True, '1', 1.5, None, 2**80]:
            self.assertEqual(self.owner.request('/api/comments/read', 'POST', {'last_read_id': value})[0], 400)
        self.assertEqual(self.owner.sync()[1]['chat']['last_read_id'], 0)

    def test_unread_counts_all_history_beyond_one_page_and_backup_preserves_it(self):
        self.seed_chat([2] * 205 + [1])
        state = self.owner.sync()[1]
        self.assertEqual(len(state['comments']), 100)
        self.assertEqual(state['chat']['unread_count'], 205)
        self.owner.request('/api/comments/read', 'POST', {'last_read_id': 150})
        backup = server.make_backup(Path(self.temp.name) / 'receipt-backup.db')
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute('SELECT last_read_id FROM comment_reads WHERE user_id=1').fetchone()[0], 150)
        self.assertEqual(self.owner.sync()[1]['chat']['unread_count'], 55)

    def test_comments_shared_and_plain_text(self):
        comment = '<script>alert(1)</script> 加油🌿'
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': comment})[0], 200)
        data = self.owner.sync()[1]
        self.assertEqual(data['comments'][0]['text'], comment)
        self.assertEqual(data['comments'][0]['name'], '陪伴者')
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': ''})[0], 400)
        self.assertEqual(self.viewer.request('/api/comments', 'POST', {'text': 'x' * 501})[0], 400)

    def test_chat_history_pagination_and_access(self):
        with server.connect() as db:
            viewer_id = db.execute("SELECT id FROM users WHERE role='viewer'").fetchone()[0]
            db.executemany('INSERT INTO comments(user_id,text,created_at) VALUES(?,?,?)',
                           [(viewer_id, f'message {i}', server.now()) for i in range(205)])
        state = self.owner.sync()[1]
        self.assertEqual([c['id'] for c in state['comments']], list(range(106, 206)))
        self.assertTrue(state['comments_has_more'])
        code, older, _ = self.viewer.request('/api/comments?before=106')
        self.assertEqual(code, 200)
        self.assertEqual([c['id'] for c in older['comments']], list(range(6, 106)))
        self.assertTrue(older['has_more'])
        oldest = self.viewer.request('/api/comments?before=6')[1]
        self.assertEqual([c['id'] for c in oldest['comments']], list(range(1, 6)))
        self.assertFalse(oldest['has_more'])
        self.assertEqual(Client(self.base).request('/api/comments')[0], 401)
        for cursor in ['0', '-1', 'abc', '999999999999999999999']:
            self.assertEqual(self.owner.request('/api/comments?before=' + cursor)[0], 400)
        self.assertEqual(len(self.owner.request('/api/backup.json')[1]['comments']), 205)

    def test_jin_labels_preserve_historical_numbers(self):
        self.assertEqual(self.save(weight=166.6)[0], 200)
        with server.connect() as db:
            plan = server.read_plan(db)
            plan.pop('weight_unit')
            plan['goal_weight'] = 150
            db.execute('UPDATE settings SET value=? WHERE id=1', (json.dumps(plan),))
        state = self.owner.sync()[1]
        self.assertEqual(state['plan']['weight_unit'], 'jin')
        self.assertEqual(state['plan']['goal_weight'], 150)
        self.assertEqual(state['records'][0]['weight'], 166.6)
        rows = list(csv.reader(io.StringIO(self.owner.request('/api/export.csv')[1].decode('utf-8-sig'))))
        self.assertEqual(rows[0][1], '体重(斤)')
        self.assertEqual(float(rows[3][1]), 166.6)
        backup = self.owner.request('/api/backup.json')[1]
        self.assertEqual(backup['weight_unit'], 'jin')
        self.assertEqual(backup['records'][0]['weight'], 166.6)
        self.assertIn('斤', self.save(weight=501, version=1)[1]['error'])

    def test_expired_session_and_finished_plan_keep_data(self):
        self.save(weight=166.6)
        self.viewer.request('/api/comments', 'POST', {'text': 'persistent message'})
        actual_today = server.today
        try:
            server.today = lambda: actual_today() + timedelta(days=110)
            self.assertEqual(self.owner.sync()[1]['records'][0]['weight'], 166.6)
            self.assertEqual(self.owner.sync()[1]['comments'][0]['text'], 'persistent message')
            with server.connect() as db:
                db.execute('UPDATE sessions SET expires=0')
            self.assertEqual(self.owner.sync()[0], 401)
            self.assertEqual(self.owner.request('/api/login', 'POST', {'username': 'recorder', 'password': ' secure owner password '})[0], 200)
            self.assertEqual(self.owner.sync()[1]['records'][0]['weight'], 166.6)
            self.assertEqual(self.owner.sync()[1]['comments'][0]['text'], 'persistent message')
        finally:
            server.today = actual_today

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

    def test_plan_auto_extends_at_boundary_and_catches_up_without_reset(self):
        self.save(weight=166.6)
        actual_today = server.today
        start = server.date.fromisoformat(self.start)
        try:
            server.today = lambda: start + timedelta(days=99)
            self.assertEqual(self.owner.sync()[1]['plan']['days'], 100)
            server.today = lambda: start + timedelta(days=100)
            state = self.owner.sync()[1]
            self.assertEqual(state['plan']['days'], 200)
            self.assertEqual(state['plan']['end_date'], (start + timedelta(days=199)).isoformat())
            self.assertEqual(state['plan']['start_date'], self.start)
            self.assertEqual(state['records'][0]['weight'], 166.6)
            version = state['plan']['version']
            self.assertEqual(self.viewer.sync()[1]['plan']['version'], version)
            self.assertEqual(self.owner.sync()[1]['plan']['days'], 200)
            self.assertEqual(self.owner.request('/api/records/' + server.today().isoformat(), 'PUT', {'weight': 165.5, 'version': 0})[0], 200)
            server.today = lambda: start + timedelta(days=301)
            state = self.owner.sync()[1]
            self.assertEqual(state['plan']['days'], 400)
            self.assertEqual(len(state['records']), 2)
            rows = list(csv.reader(io.StringIO(self.owner.request('/api/export.csv')[1].decode('utf-8-sig'))))
            self.assertEqual(len(rows), 401)
            server.initialize()
            # Extension totals are persisted, even if the clock later moves backwards.
            server.today = actual_today
            self.assertEqual(self.owner.sync()[1]['plan']['days'], 400)
        finally:
            server.today = actual_today

    def test_manual_end_stops_extension_and_can_be_resumed(self):
        self.save()
        start = server.date.fromisoformat(self.start)
        end = (start + timedelta(days=29)).isoformat()
        self.assertEqual(self.owner.request('/api/plan', 'PUT', {'end_date': end, 'version': 1})[0], 200)
        plan = self.owner.sync()[1]['plan']
        self.assertFalse(plan['auto_extend'])
        self.assertEqual(plan['days'], 30)
        actual_today = server.today
        try:
            server.today = lambda: start + timedelta(days=150)
            self.assertEqual(self.owner.sync()[1]['plan']['days'], 30)
            self.assertEqual(self.owner.request('/api/records/' + server.today().isoformat(), 'PUT', {'weight': 160, 'version': 0})[0], 400)
            self.assertEqual(self.owner.request('/api/plan', 'PUT', {'goal_weight': 150, 'version': plan['version']})[0], 200)
            plan = self.owner.sync()[1]['plan']
            self.assertFalse(plan['auto_extend'])
            self.assertEqual(plan['end_date'], end)
            self.assertEqual(self.owner.request('/api/plan', 'PUT', {'auto_extend': True, 'version': plan['version']})[0], 200)
            self.assertTrue(self.owner.sync()[1]['plan']['auto_extend'])
            self.assertEqual(self.owner.sync()[1]['plan']['days'], 230)
        finally:
            server.today = actual_today

    def test_manual_end_validation_and_viewer_permissions(self):
        self.save()
        for payload in [
            {'end_date': (server.today() - timedelta(days=1)).isoformat()},
            {'end_date': (server.date.fromisoformat(self.start) - timedelta(days=1)).isoformat()},
            {'end_date': 'invalid'},
            {'end_date': '9999-01-01'},
            {'auto_extend': 'true'},
        ]:
            self.assertEqual(self.owner.request('/api/plan', 'PUT', {**payload, 'version': 1})[0], 400)
        self.assertEqual(self.viewer.request('/api/plan', 'PUT', {'end_date': self.day, 'version': 1})[0], 403)
        self.assertEqual(self.owner.sync()[1]['plan']['days'], 100)

    def test_simultaneous_plan_reads_extend_only_once(self):
        from concurrent.futures import ThreadPoolExecutor
        actual_today = server.today
        try:
            server.today = lambda: server.date.fromisoformat(self.start) + timedelta(days=100)
            with ThreadPoolExecutor(max_workers=2) as pool:
                states = list(pool.map(lambda client: client.sync()[1], [self.owner, self.viewer]))
            self.assertEqual([s['plan']['days'] for s in states], [200, 200])
            self.assertEqual([s['plan']['version'] for s in states], [2, 2])
        finally:
            server.today = actual_today

    def test_csv_export_and_formula_injection(self):
        self.save(note='=HYPERLINK("https://example.com")')
        code, raw, headers = self.owner.request('/api/export.csv')
        self.assertEqual(code, 200)
        rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'))))
        self.assertEqual(len(rows), 101)
        self.assertEqual(rows[0], ['日期', '体重(斤)', '备注'])
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
