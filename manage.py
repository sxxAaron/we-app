"""Deployment initialization, consistent backups, and local password recovery."""
import argparse
import getpass
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description='一起，轻一点 · 管理工具')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init-env', help='生成部署配置，不覆盖已有配置')
    init.add_argument('--domain', default='', help='例如 weight.example.com，不含 https://')
    commands.add_parser('setup-token', help='在自己的服务器终端查看一次性初始化密钥')
    backup = commands.add_parser('backup', help='创建一致的 SQLite 备份')
    backup.add_argument('--output', help='输出路径，默认放入数据库旁的 backups 目录')
    recovery = commands.add_parser('reset-password', help='在服务器终端交互式重置密码')
    recovery.add_argument('username')
    args = parser.parse_args()
    if args.command == 'init-env':
        if args.domain and (not all(c.isalnum() or c in '.-' for c in args.domain) or '.' not in args.domain):
            parser.error('域名只能包含字母、数字、点和横线，例如 weight.example.com')
        path = ROOT / '.env'
        if path.exists():
            raise SystemExit('.env 已存在，未覆盖。请直接编辑自己的配置。')
        config = f'''# 本文件包含秘密，不要提交到 Git 或发送给他人。
SETUP_TOKEN={secrets.token_urlsafe(32)}
DOMAIN={args.domain}
PUBLIC_ORIGIN={'https://' + args.domain if args.domain else ''}
COOKIE_SECURE=true
PORT=8080
HOST=127.0.0.1
DB_PATH={ROOT / 'data/journal.db'}
'''
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(config)
        print('已生成 .env（仅本机当前用户可读写）。')
        print('使用 python3 manage.py setup-token 在自己的终端查看初始化密钥。')
        if not args.domain:
            print('尚未配置域名。请先通过已有 HTTPS 反向代理接入，或设置域名后使用 Caddy。')
        return
    import server
    if args.command == 'setup-token':
        if not server.SETUP_TOKEN:
            raise SystemExit('尚未配置密钥，请先执行 python3 manage.py init-env')
        print(server.SETUP_TOKEN)
    elif args.command == 'backup':
        if not server.DB_PATH.exists():
            raise SystemExit('数据库不存在，请先启动并初始化应用。')
        print(f'备份已创建：{server.make_backup(args.output)}')
    elif args.command == 'reset-password':
        if not server.DB_PATH.exists():
            raise SystemExit('数据库不存在。')
        password = getpass.getpass('新密码（至少10个字符，输入不显示）：')
        if password != getpass.getpass('再次输入新密码：'):
            raise SystemExit('两次输入不一致，未修改。')
        try:
            server.valid_password(password)
        except server.APIError as error:
            raise SystemExit(error.message)
        with server.connect() as db:
            user = db.execute('SELECT id FROM users WHERE username=?', (args.username,)).fetchone()
            if not user:
                raise SystemExit('账号不存在，未修改。')
            db.execute('UPDATE users SET password=? WHERE id=?', (server.hash_password(password), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
        print('密码已重置，该账号所有设备已退出登录。')


if __name__ == '__main__':
    main()
