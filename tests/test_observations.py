import base64
import io
import time
import unittest
from unittest.mock import patch

from test_security import server


class ObservationTests(unittest.TestCase):
    headers = {'X-ROVSSA-Proxy': 'a' * 64, 'X-Forwarded-Proto': 'https',
               'Origin': 'https://rover.test', 'X-ROVSSA-Request': '1'}

    def setUp(self):
        self.client = server.app.test_client()

    def capture(self):
        return self.client.post('/observations/csi', json={}, headers=self.headers)

    def test_evidence_requires_operator_and_origin(self):
        self.assertEqual(self.client.post('/observations/csi', json={}).status_code, 401)
        headers = dict(self.headers, Origin='https://elsewhere.test')
        self.assertEqual(self.client.post('/observations/csi', json={}, headers=headers).status_code, 403)

    def test_simulation_explicit_no_invented_measurements(self):
        data = self.capture().json
        self.assertTrue(data['simulation'])
        for field in ['gps', 'imu', 'jpeg_base64']:
            self.assertIsNone(data[field])

    @patch.object(server, 'SIMULATION', False)
    def test_real_image_and_expired_inputs(self):
        with patch.dict(server.frames, clear=True):
            self.assertEqual(self.capture().status_code, 409)
            frame = b'\xff\xd8test\xff\xd9'
            server.frames['csi'] = (time.monotonic(), 'test-time', frame)
            data = self.capture().json
            self.assertEqual(base64.b64decode(data['jpeg_base64']), frame)
            self.assertFalse(data['simulation'])
            self.assertEqual(data['frame_received_at'], 'test-time')
            stream = server.camera_csi().response
            self.assertIn(frame, next(stream))
            stream.close()
            server.frames['csi'] = (time.monotonic()-4, 'expired', frame)
            self.assertEqual(self.capture().status_code, 409)

    def test_jpeg_split_at_chunk_boundary(self):
        buffer = io.BytesIO(b'X' * 65535 + b'\xff\xd8abc\xff\xd9')
        self.assertEqual(list(server._parse_jpeg_frames(buffer)), [b'\xff\xd8abc\xff\xd9'])

