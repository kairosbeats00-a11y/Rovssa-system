import base64
import hashlib
import json
import os
import tempfile
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from unittest.mock import patch

from test_security import server


class EventArchiveTests(unittest.TestCase):
    headers = {'X-ROVSSA-Proxy':'a'*64, 'X-Forwarded-Proto':'https',
               'Origin':'https://rover.test', 'X-ROVSSA-Request':'1'}

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        setting = patch.dict(os.environ, ROVSSA_EVENT_DIR=directory.name)
        setting.start()
        self.addCleanup(setting.stop)
        self.client = server.app.test_client()
        self.id = str(uuid.uuid4())

    def capture(self):
        return self.client.post('/events', json={'id':self.id}, headers=self.headers)

    def test_full_snapshot_and_exact_bytes_after_reconnect(self):
        now = time.monotonic()
        frames = {name:(now,'sample-time',name.encode()) for name in ('csi','usb')}
        readings = {'imu_updated':now, 'pitch':12, 'distancia_frontal':1.5,
                    'distancia_frontal_updated':now}
        with patch.dict(server.frames, frames), patch.dict(server.current_telemetry,readings), patch.dict(
            server.gps_state,fix=True,updated_at=now,lat=-31,lon=-64
        ), patch.dict(server.pico_state,connected=True,updated_at=now,enc=[1,2,3,4],ch=[1500],mode='RC'):
            meta = self.capture().json
        recovered = server.app.test_client().get('/events/'+self.id, headers=self.headers)
        self.assertEqual(meta['digest'],'0x'+hashlib.sha256(recovered.data).hexdigest())
        item = json.loads(recovered.json["payload"])
        for name in frames:
            self.assertEqual(base64.b64decode(item['cameras'][name]['jpeg_base64']), name.encode())
        self.assertEqual(item['imu_degrees']['pitch'],12)
        self.assertEqual(item['gps']['lon'],-64)
        self.assertEqual(item['proximity_m']['frontal'],1.5)
        self.assertEqual(item['pico']['encoders']['RR'],4)
        self.assertIn('odometry',item['pico'])
        self.assertEqual(item['pico']['rc_channels'],[1500])
        self.assertEqual(self.capture().json,meta)
        self.assertEqual(self.client.get('/events',headers=self.headers).json,[meta])

    def test_local_trigger_and_stale_devices(self):
        with patch.dict(server.frames,csi=(0,'old',b'old')), patch.dict(server.gps_state,updated_at=0,fix=True):
            server.record_event(self.id,'local')
        data = json.loads(self.client.get('/events/'+self.id,headers=self.headers).json['payload'])
        self.assertEqual(data['trigger'],'local')
        self.assertEqual(data['cameras'],{'csi':None,'usb':None})
        self.assertIsNone(data['gps'])
        self.assertIsNone(data['imu_degrees'])
        self.assertIsNone(data['pico'])

    def test_persistent_identity_and_modified_capture(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            keys = list(pool.map(lambda _: server.identity.public_key(), range(8)))
        self.assertEqual(len(set(keys)), 1)
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(), bytes.fromhex(keys[0][2:]))
        self.capture()
        record = self.client.get('/events/'+self.id,headers=self.headers).json
        raw = record['signature']
        signature = utils.encode_dss_signature(int(raw[:64],16), int(raw[64:],16))
        payload = record['payload'].encode()
        key.verify(signature, payload, ec.ECDSA(hashes.SHA256()))
        edited = json.loads(payload)
        edited['gps'] = {'lat':45, 'lon':10}
        with self.assertRaises(InvalidSignature):
            key.verify(signature, json.dumps(edited).encode(), ec.ECDSA(hashes.SHA256()))
        self.assertEqual(self.client.get('/identity',headers=self.headers).json, {'public_key': keys[0]})
        self.assertEqual(self.client.get('/identity').status_code, 401)

    def test_component_logs_are_read_only_and_authenticated(self):
        self.assertEqual(self.client.get('/diagnostics').status_code,401)
        report = self.client.get('/diagnostics',headers=self.headers).json
        self.assertTrue(report['simulation'])
        self.assertFalse(report['signals']['csi'])
        self.assertTrue(report['logs']['csi'])
        self.assertEqual(self.client.post('/diagnostics',headers=self.headers,json={}).status_code,405)

    def test_archive_requires_auth_and_valid_id(self):
        for path in ['/events','/events/'+self.id]:
            self.assertEqual(self.client.get(path).status_code,401)
        self.assertEqual(self.client.post('/events',json={}).status_code,401)
        self.assertEqual(self.client.post('/events',headers=self.headers,json={}).status_code,400)
        self.assertEqual(self.client.get('/events/'+self.id,headers=self.headers).status_code,404)

