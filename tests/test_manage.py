import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class DeploymentConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        shutil.copy(Path(__file__).resolve().parents[1] / 'manage.py', self.folder / 'manage.py')

    def tearDown(self):
        self.temp.cleanup()

    def run_init(self, *args):
        return subprocess.run([sys.executable, str(self.folder / 'manage.py'), 'init-env', *args], capture_output=True, text=True)

    def config(self):
        return dict(line.split('=', 1) for line in (self.folder / '.env').read_text().splitlines() if line and not line.startswith('#'))

    def test_public_ip_generates_https_config(self):
        # This only validates syntax and writes a temporary file; no network call.
        result = self.run_init('--ip', '8.8.8.8')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.config()
        self.assertEqual(config['SERVER_IP'], '8.8.8.8')
        self.assertEqual(config['DOMAIN'], '')
        self.assertEqual(config['PUBLIC_ORIGIN'], 'https://8.8.8.8')
        self.assertEqual(config['COOKIE_SECURE'], 'true')
        self.assertGreaterEqual(len(config['SETUP_TOKEN']), 32)
        self.assertNotIn(config['SETUP_TOKEN'], result.stdout)
        self.assertEqual(os.stat(self.folder / '.env').st_mode & 0o777, 0o600)

    def test_private_invalid_and_ipv6_addresses_rejected(self):
        for ip in ['127.0.0.1', '192.168.1.2', '10.0.0.1', '0.0.0.0', '224.0.0.1', '203.0.113.10', '::1', 'https://1.1.1.1', '999.1.1.1']:
            with self.subTest(ip=ip):
                self.assertNotEqual(self.run_init('--ip', ip).returncode, 0)
                self.assertFalse((self.folder / '.env').exists())

    def test_domain_and_ip_are_mutually_exclusive(self):
        self.assertNotEqual(self.run_init('--domain', 'example.com', '--ip', '8.8.8.8').returncode, 0)
        self.assertFalse((self.folder / '.env').exists())

    def test_domain_keeps_secure_defaults(self):
        result = self.run_init('--domain', 'weight.example.com')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.config()
        self.assertEqual(config['PUBLIC_ORIGIN'], 'https://weight.example.com')
        self.assertEqual(config['COOKIE_SECURE'], 'true')
        self.assertEqual(config['SERVER_IP'], '')

    def test_existing_configuration_is_never_overwritten(self):
        self.assertEqual(self.run_init('--ip', '8.8.8.8').returncode, 0)
        previous = (self.folder / '.env').read_bytes()
        self.assertNotEqual(self.run_init('--ip', '1.1.1.1').returncode, 0)
        self.assertEqual(previous, (self.folder / '.env').read_bytes())

    def test_http_trial_requires_explicit_flag_and_generates_matching_origin(self):
        result = self.run_init('--http-ip', '8.8.8.8', '--port', '40039')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.config()
        self.assertEqual(config['PUBLIC_ORIGIN'], 'http://8.8.8.8:40039')
        self.assertEqual(config['COOKIE_SECURE'], 'false')
        self.assertEqual(config['BIND_ADDRESS'], '0.0.0.0')
        self.assertEqual(config['APP_PORT'], '40039')
        self.assertEqual(config['SERVER_IP'], '')
        self.assertIn('未加密', result.stdout)

    def test_http_flag_cannot_be_mixed_with_https(self):
        self.assertNotEqual(self.run_init('--http-ip', '8.8.8.8', '--domain', 'example.com').returncode, 0)
        self.assertNotEqual(self.run_init('--http-ip', '8.8.8.8', '--ip', '1.1.1.1').returncode, 0)
        self.assertFalse((self.folder / '.env').exists())

    def test_invalid_http_ports_are_rejected(self):
        for port in ['0', '80', '443', '-1', '65536', 'abc']:
            with self.subTest(port=port):
                self.assertNotEqual(self.run_init('--http-ip', '8.8.8.8', '--port', port).returncode, 0)
                self.assertFalse((self.folder / '.env').exists())


if __name__ == '__main__':
    unittest.main()
