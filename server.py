"""Two-person weight journal. Python 3.11+, standard library only."""
import csv
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent


def load_env():
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip())


load_env()
DB_PATH = Path(os.environ.get('DB_PATH', str(ROOT / 'data/journal.db')))
SETUP_TOKEN = os.environ.get('SETUP_TOKEN', '')
COOKIE_SECURE = os.environ.get('COOKIE_SECURE', 'true').lower() == 'true'
PUBLIC_ORIGIN = os.environ.get('PUBLIC_ORIGIN', '').rstrip('/')
# The plan uses modern China standard time. Fixed UTC+8 avoids a tzdata package
# dependency in minimal Docker images.
TZ = timezone(timedelta(hours=8), name='Asia/Shanghai')
SESSION_SECONDS = 7 * 86400
SCHEMA = '''
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
 password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','viewer')));
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records (
 day TEXT PRIMARY KEY, weight REAL NOT NULL, note TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, at INTEGER NOT NULL);
'''


def connect():
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db


def initialize():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript(SCHEMA)


def today():
    return datetime.now(TZ).date()


def now():
    return datetime.now(TZ).isoformat(timespec='seconds')


def hash_password(value):
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac('sha256', value.encode(), bytes.fromhex(salt), 600000)
    return f'pbkdf2_sha256$600000${salt}${digest.hex()}'


def verify_password(value, stored):
    try:
        _, rounds, salt, digest = stored.split('$')
        check = hashlib.pbkdf2_hmac('sha256', value.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(check.hex(), digest)
    except (ValueError, TypeError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def valid_password(value):
    if not isinstance(value, str) or not 10 <= len(value) <= 128:
        raise APIError(400, '密码需要 10～128 个字符')
    return value


def text_field(value, limit, label, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise APIError(400, f'{label}不能为空或超过 {limit} 个字符' if required else f'{label}最多 {limit} 个字符')
    return value.strip()


def valid_day(value):
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError
        return parsed
    except (ValueError, TypeError):
        raise APIError(400, '日期格式无效')


def valid_weight(value, optional=False):
    if optional and value in (None, ''):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 1 <= value <= 500:
        raise APIError(400, '请输入 1～500 斤 之间的体重')
    return round(value, 2)


def read_plan(db):
    plan = json.loads(db.execute('SELECT value FROM settings WHERE id=1').fetchone()[0])
    # Historical numbers were entered in jin; keep them unchanged.
    plan.setdefault('weight_unit', 'jin')
    plan.setdefault('auto_extend', True)
    plan['end_date'] = (date.fromisoformat(plan['start_date']) + timedelta(days=plan['days'] - 1)).isoformat()
    return plan


def extend_plan_if_needed(db):
    """Catch up in 100-day blocks under a lock; each boundary is applied once."""
    plan = read_plan(db)
    if not plan['auto_extend'] or today().isoformat() <= plan['end_date']:
        return
    db.execute('BEGIN IMMEDIATE')
    try:
        plan = read_plan(db)
        overdue = (today() - date.fromisoformat(plan['end_date'])).days
        if plan['auto_extend'] and overdue > 0:
            plan['days'] += ((overdue - 1) // 100 + 1) * 100
            plan['end_date'] = (date.fromisoformat(plan['start_date']) + timedelta(days=plan['days'] - 1)).isoformat()
            plan['version'] += 1
            db.execute('UPDATE settings SET value=? WHERE id=1', (json.dumps(plan),))
        db.commit()
    except Exception:
        db.rollback()
        raise


def read_comments(db, before=None):
    condition = 'WHERE comments.id<?' if before is not None else ''
    rows = [dict(row) for row in db.execute(f'''SELECT comments.id,text,created_at,users.name,users.role,
        users.id AS user_id FROM comments JOIN users ON users.id=comments.user_id
        {condition} ORDER BY comments.id DESC LIMIT 101''', (before,) if before is not None else ())]
    return {'comments': rows[:100][::-1], 'has_more': len(rows) > 100}


def make_backup(destination=None):
    directory = DB_PATH.parent / 'backups'
    directory.mkdir(exist_ok=True)
    target = Path(destination) if destination else directory / f'journal-{today()}.sqlite3'
    temporary = target.with_suffix(target.suffix + '.tmp')
    with connect() as source, sqlite3.connect(temporary) as output:
        source.backup(output)
    temporary.replace(target)
    if destination is None:
        for old in sorted(directory.glob('journal-*.sqlite3'))[:-14]:
            old.unlink()
    return target


def backup_loop():
    while True:
        try:
            make_backup()
        except Exception as error:
            print(f'Backup failed: {type(error).__name__}', flush=True)
        time.sleep(3600)


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class Handler(BaseHTTPRequestHandler):
    server_version = 'WeightJournal'

    def log_message(self, fmt, *args):
        # Never log payloads, cookies, tokens, or URL query strings.
        print(f'{self.command} {urlsplit(self.path).path} {args[1] if len(args) > 1 else ""}', flush=True)

    def send(self, status, data, content_type='application/json; charset=utf-8', cookie=None, filename=None):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if COOKIE_SECURE:
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError
            result = json.loads(self.rfile.read(length))
            if not isinstance(result, dict):
                raise ValueError
            return result
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, '请求格式无效')

    def check_origin(self):
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, '请求来源不匹配，请从本站操作')
        origin = self.headers.get('Origin')
        if origin:
            if PUBLIC_ORIGIN:
                allowed = PUBLIC_ORIGIN
            else:
                allowed = ('https' if COOKIE_SECURE else 'http') + '://' + self.headers.get('Host', '')
            if origin != allowed:
                raise APIError(403, '请求来源不匹配，请从本站操作')

    def session(self, db, mutate=False, owner=False):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
            token = cookies['journal_session'].value
        except (KeyError, ValueError):
            raise APIError(401, '请先登录')
        row = db.execute('''SELECT users.id,username,name,role,sessions.csrf,sessions.token
            FROM sessions JOIN users ON users.id=sessions.user_id
            WHERE token=? AND expires>?''', (token_hash(token), int(time.time()))).fetchone()
        if not row:
            raise APIError(401, '登录已过期，请重新登录')
        if owner and row['role'] != 'owner':
            raise APIError(403, '只有记录者可以修改体重和计划')
        if mutate and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), row['csrf']):
            raise APIError(403, '页面验证已失效，请刷新后重试')
        return row

    def new_session(self, db, user_id):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        db.execute('DELETE FROM sessions WHERE expires<=?', (int(time.time()),))
        db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (token_hash(token), user_id, csrf, int(time.time()) + SESSION_SECONDS))
        secure = '; Secure' if COOKIE_SECURE else ''
        return f'journal_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}{secure}'

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PUT(self):
        self.handle_request('PUT')

    def do_DELETE(self):
        self.handle_request('DELETE')

    def handle_request(self, method):
        try:
            path = urlsplit(self.path).path
            if not path.startswith('/api/'):
                if method != 'GET':
                    raise APIError(405, '不支持此操作')
                files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css',
                         '/icon.svg': 'icon.svg', '/manifest.webmanifest': 'manifest.webmanifest'}
                if path not in files:
                    raise APIError(404, '页面不存在')
                extension = files[path].split('.')[-1]
                mime = {'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8',
                        'css': 'text/css; charset=utf-8', 'svg': 'image/svg+xml', 'webmanifest': 'application/manifest+json'}[extension]
                return self.send(200, (ROOT / 'static' / files[path]).read_bytes(), mime)
            if method != 'GET':
                self.check_origin()
            with connect() as db:
                result = self.api(db, method, path)
            self.send(*result)
        except APIError as error:
            self.send(error.status, {'error': error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(f'Request failed: {type(error).__name__}', flush=True)
            self.send(500, {'error': '暂时无法完成，请稍后重试'})

    def api(self, db, method, path):
        if path == '/api/health' and method == 'GET':
            db.execute('SELECT 1')
            return 200, {'ok': True}
        if path == '/api/status' and method == 'GET':
            return 200, {'setupRequired': db.execute('SELECT id FROM settings').fetchone() is None}
        if path in ('/api/setup', '/api/login') and method == 'POST':
            payload = self.body()
            # Proxy addresses are deliberately not trusted. Two users share a generous budget.
            ip = token_hash(self.client_address[0])
            db.execute('DELETE FROM attempts WHERE at<?', (int(time.time()) - 900,))
            if db.execute('SELECT count(*) FROM attempts WHERE ip=?', (ip,)).fetchone()[0] >= 12:
                raise APIError(429, '尝试次数过多，请 15 分钟后再试')
            db.execute('INSERT INTO attempts VALUES(?,?)', (ip, int(time.time())))
            db.commit()  # Persist failed attempts as well as successful attempts.
            if path == '/api/setup':
                if not SETUP_TOKEN or not hmac.compare_digest(str(payload.get('token', '')), SETUP_TOKEN):
                    raise APIError(403, '初始化密钥不正确，请在服务器上查看')
                # Serialize first-time setup so simultaneous requests cannot create extra users.
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT id FROM settings').fetchone():
                    raise APIError(409, '已完成初始化，请直接登录')
                usernames = []
                for prefix, role, default_name in [('owner', 'owner', '记录者'), ('viewer', 'viewer', '陪伴者')]:
                    username = text_field(payload.get(prefix + '_username'), 32, '登录账号', True)
                    if not re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', username):
                        raise APIError(400, '账号需要 3～32 位字母、数字、点、横线或下划线')
                    if username in usernames:
                        raise APIError(400, '两个账号不能相同')
                    usernames.append(username)
                    password = valid_password(payload.get(prefix + '_password'))
                    name = text_field(payload.get(prefix + '_name', default_name), 24, '昵称', True)
                    db.execute('INSERT INTO users(username,name,password,role) VALUES(?,?,?,?)', (username, name, hash_password(password), role))
                start = valid_day(payload.get('start_date', '2026-10-19'))
                plan = {'start_date': start.isoformat(), 'days': 100, 'goal_weight': None, 'weight_unit': 'jin', 'auto_extend': True, 'version': 1}
                db.execute('INSERT INTO settings VALUES(1,?)', (json.dumps(plan),))
                user_id = db.execute("SELECT id FROM users WHERE role='owner'").fetchone()[0]
            else:
                username = text_field(payload.get('username'), 32, '账号', True)
                password = payload.get('password')
                if not isinstance(password, str) or not 1 <= len(password) <= 128:
                    raise APIError(400, '请输入密码，最多 128 个字符')
                user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
                if not user or not verify_password(password, user['password']):
                    if not user:
                        hashlib.pbkdf2_hmac('sha256', password.encode(), b'dummy-login-salt', 600000)
                    raise APIError(401, '账号或密码不正确')
                user_id = user['id']
            cookie = self.new_session(db, user_id)
            db.execute('DELETE FROM attempts WHERE ip=?', (ip,))
            return 200, {'ok': True}, 'application/json; charset=utf-8', cookie
        user = self.session(db, mutate=method != 'GET')
        if path in ('/api/state', '/api/plan', '/api/export.csv', '/api/backup.json') or path.startswith('/api/records/'):
            extend_plan_if_needed(db)
        if path == '/api/state' and method == 'GET':
            history = read_comments(db)
            return 200, {'user': {k: user[k] for k in ('id', 'username', 'name', 'role')}, 'csrf': user['csrf'],
                         'plan': read_plan(db), 'today': today().isoformat(),
                         'records': [dict(row) for row in db.execute('SELECT * FROM records ORDER BY day')],
                         'comments': history['comments'], 'comments_has_more': history['has_more']}
        if path == '/api/comments' and method == 'GET':
            raw = parse_qs(urlsplit(self.path).query).get('before', [''])[0]
            if raw and (not re.fullmatch(r'[0-9]{1,18}', raw) or int(raw) < 1):
                raise APIError(400, '留言游标无效')
            return 200, read_comments(db, int(raw) if raw else None)
        if path == '/api/logout' and method == 'POST':
            db.execute('DELETE FROM sessions WHERE token=?', (user['token'],))
            return 200, {'ok': True}, 'application/json; charset=utf-8', 'journal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + ('; Secure' if COOKIE_SECURE else '')
        if path.startswith('/api/records/') and method in ('PUT', 'DELETE'):
            self.session(db, mutate=True, owner=True)
            day = valid_day(path.removeprefix('/api/records/'))
            plan = read_plan(db)
            start = date.fromisoformat(plan['start_date'])
            if not start <= day <= date.fromisoformat(plan['end_date']):
                raise APIError(400, '日期不在计划范围内')
            if day > today():
                raise APIError(400, '还不能记录未来的体重')
            payload = self.body()
            version = payload.get('version')
            if type(version) is not int or version < 0:
                raise APIError(400, '记录版本无效，请刷新后重试')
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT * FROM records WHERE day=?', (day.isoformat(),)).fetchone()
            if (existing['version'] if existing else 0) != version:
                raise APIError(409, '这条记录已在其他页面更新，请刷新后再修改')
            if method == 'DELETE':
                db.execute('DELETE FROM records WHERE day=?', (day.isoformat(),))
            else:
                weight = valid_weight(payload.get('weight'))
                note = text_field(payload.get('note', ''), 500, '备注')
                db.execute('''INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET
                    weight=excluded.weight,note=excluded.note,version=excluded.version,updated_at=excluded.updated_at''',
                           (day.isoformat(), weight, note, version + 1, now()))
            return 200, {'ok': True}
        if path == '/api/comments' and method == 'POST':
            payload = self.body()
            text = text_field(payload.get('text'), 500, '留言', True)
            latest = db.execute('SELECT created_at FROM comments WHERE user_id=? ORDER BY id DESC LIMIT 1', (user['id'],)).fetchone()
            if latest and (datetime.now(TZ) - datetime.fromisoformat(latest[0])).total_seconds() < 3:
                raise APIError(429, '发送得有点快，请稍等几秒')
            db.execute('INSERT INTO comments(user_id,text,created_at) VALUES(?,?,?)', (user['id'], text, now()))
            return 200, {'ok': True}
        if path == '/api/plan' and method == 'PUT':
            self.session(db, mutate=True, owner=True)
            payload = self.body()
            db.execute('BEGIN IMMEDIATE')
            current = read_plan(db)
            if payload.get('version') != current['version']:
                raise APIError(409, '计划已在其他页面更新，请刷新后重试')
            start = valid_day(payload.get('start_date', current['start_date']))
            goal = valid_weight(payload['goal_weight'], optional=True) if 'goal_weight' in payload else current['goal_weight']
            auto_extend = payload.get('auto_extend', False if 'end_date' in payload else current['auto_extend'])
            if type(auto_extend) is not bool:
                raise APIError(400, '自动延续设置无效')
            if auto_extend:
                days = current['days']
                elapsed_days = (today() - start).days + 1
                if elapsed_days > days:
                    days += ((elapsed_days - days - 1) // 100 + 1) * 100
                try:
                    end = start + timedelta(days=days - 1)
                except OverflowError:
                    raise APIError(400, '计划日期范围无效')
            else:
                end = valid_day(payload.get('end_date', current['end_date']))
                days = (end - start).days + 1
                if not 1 <= days <= 36525:
                    raise APIError(400, '结束日期不得早于开始日期，计划范围最多为 100 年')
            if db.execute('SELECT day FROM records WHERE day<? OR day>? LIMIT 1', (start.isoformat(), end.isoformat())).fetchone():
                raise APIError(400, '修改后的计划会排除已有记录，请保留这些日期')
            current.update(start_date=start.isoformat(), end_date=end.isoformat(), days=days,
                           auto_extend=auto_extend, goal_weight=goal, version=current['version'] + 1)
            db.execute('UPDATE settings SET value=? WHERE id=1', (json.dumps(current),))
            return 200, {'ok': True}
        if path == '/api/password' and method == 'POST':
            payload = self.body()
            current = payload.get('current')
            if not isinstance(current, str) or not 1 <= len(current) <= 128:
                raise APIError(400, '请输入当前密码')
            password = valid_password(payload.get('password'))
            stored = db.execute('SELECT password FROM users WHERE id=?', (user['id'],)).fetchone()[0]
            if not verify_password(current, stored):
                raise APIError(400, '当前密码不正确')
            db.execute('UPDATE users SET password=? WHERE id=?', (hash_password(password), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=? AND token!=?', (user['id'], user['token']))
            return 200, {'ok': True}
        if path == '/api/export.csv' and method == 'GET':
            stream = io.StringIO(newline='')
            writer = csv.writer(stream)
            writer.writerow(['日期', '体重(斤)', '备注'])
            records = {r['day']: dict(r) for r in db.execute('SELECT * FROM records')}
            plan = read_plan(db)
            for i in range(plan['days']):
                day = (date.fromisoformat(plan['start_date']) + timedelta(days=i)).isoformat()
                row = records.get(day)
                note = row['note'] if row else ''
                if note.lstrip().startswith(('=', '+', '-', '@')) or note.startswith(('\t', '\r', '\n')):
                    note = "'" + note
                writer.writerow([day, row['weight'] if row else '', note])
            return 200, ('\ufeff' + stream.getvalue()).encode(), 'text/csv; charset=utf-8', None, 'weight-journal.csv'
        if path == '/api/backup.json' and method == 'GET':
            self.session(db, owner=True)
            data = {'schema': 2, 'weight_unit': 'jin', 'exported_at': now(), 'plan': read_plan(db),
                    'records': [dict(r) for r in db.execute('SELECT * FROM records ORDER BY day')],
                    'comments': [dict(r) for r in db.execute('SELECT text,created_at,name,role FROM comments JOIN users ON users.id=comments.user_id ORDER BY comments.id')]}
            return 200, json.dumps(data, ensure_ascii=False).encode(), 'application/json; charset=utf-8', None, 'weight-journal-backup.json'
        raise APIError(404, '接口不存在')


if __name__ == '__main__':
    initialize()
    with connect() as db:
        if db.execute('SELECT id FROM settings').fetchone() is None and len(SETUP_TOKEN) < 20:
            raise SystemExit('请先执行 python3 manage.py init-env 生成初始化密钥。')
    server = ThreadingHTTPServer((os.environ.get('HOST', '127.0.0.1'), int(os.environ.get('PORT', '8080'))), Handler)
    server.daemon_threads = True
    threading.Thread(target=backup_loop, daemon=True).start()
    print(f'Weight journal running at http://{server.server_address[0]}:{server.server_address[1]}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
