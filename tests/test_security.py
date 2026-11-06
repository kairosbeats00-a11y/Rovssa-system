import unittest.mock
import importlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'entorno de simulacion'))
os.environ['ROVSSA_SIMULATION'] = '1'
os.environ['ROVSSA_PROXY_SECRET'] = 'a' * 64  # test-only fixture, never deployment credentials
os.environ['ROVSSA_ORIGIN'] = 'https://rover.test'
from safety import SafetyController
import jetson_server as server
import mission_executor as missions


class GateTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.s = SafetyController(lambda: self.now)

    def arm(self):
        self.s.heartbeat()
        return self.s.rearm(self.s.epoch)['epoch']

    def test_starts_disarmed(self):
        self.assertTrue(self.s.estop)
        with self.assertRaises(ValueError): self.s.drive(.2, 0, 0, 1)

    def test_rearm_requires_live_heartbeat(self):
        with self.assertRaises(ValueError): self.s.rearm(0)

    def test_limits_types_nan_infinity(self):
        epoch=self.arm()
        for invalid in [1, -1, float('nan'), float('inf'), '0.1', None, True]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.s.drive(invalid, 0, epoch, 1)

    def test_turn_limit(self):
        with self.assertRaises(ValueError): self.s.drive(0, .61, self.arm(), 1)

    def test_drive_and_serial_output(self):
        self.s.drive(.2, -.3, self.arm(), 1)
        output=[]; self.s.dispatch(output.append)
        self.assertEqual(output, [{'cmd':'drive','vx':.2,'omega':-.3}])

    def test_stop_replaces_queued_movement(self):
        epoch=self.arm();self.s.drive(.2,0,epoch,1);self.s.trip()
        output=[];self.s.dispatch(output.append)
        self.assertEqual(output,[{'cmd':'stop'}])
        with self.assertRaises(ValueError):self.s.drive(.2,0,epoch,2)

    def test_old_commands_cannot_survive_rearm(self):
        epoch=self.arm();self.s.trip();self.arm()
        with self.assertRaises(ValueError):self.s.drive(.2,0,epoch,99)

    def test_out_of_order(self):
        epoch=self.arm();self.s.drive(.2,0,epoch,10)
        with self.assertRaises(ValueError):self.s.drive(-.2,0,epoch,9)

    def test_drive_timeout_even_with_heartbeat(self):
        self.s.drive(.2,0,self.arm(),1);self.now+=.6;self.s.heartbeat()
        self.assertTrue(self.s.estop)

    def test_heartbeat_timeout_latches(self):
        self.arm();self.now+=2.1;self.s.heartbeat()
        self.assertTrue(self.s.estop)

    def test_expired_drive_dropped_at_dispatch(self):
        self.s.drive(.2,0,self.arm(),1);self.now+=.6
        output=[];self.s.dispatch(output.append)
        self.assertEqual(output,[{'cmd':'stop'}])

    def test_alternative_actuators_denied(self):
        self.arm()
        for cmd in [{'cmd':'arm_pick'}, {'cmd':'drive','vx':.1,'omega':0}]:
            with self.assertRaises(ValueError):self.s.submit(cmd)


class APITests(unittest.TestCase):
    def setUp(self):
        server.safety=SafetyController()
        self.c=server.app.test_client()
        self.headers={'X-ROVSSA-Proxy':'a'*64,'X-Forwarded-Proto':'https',
                      'Origin':'https://rover.test','X-ROVSSA-Request':'1'}

    def post(self,path,data,headers=None):
        if isinstance(data, dict):data = {'session':server.safety.session, **data}
        return self.c.post(path,json=data,headers=self.headers if headers is None else headers)

    def test_all_routes_require_authentication(self):
        for path in ['/status','/telemetry','/arm_telemetry','/video_feed','/camera_usb','/camera_csi','/mission/status','/yolo_status']:
            with self.subTest(path=path):self.assertEqual(self.c.get(path).status_code,401)
        for path in ['/command','/mission','/mission/stop','/heartbeat']:
            with self.subTest(path=path):self.assertEqual(self.c.post(path,json={}).status_code,401)

    def test_wrong_proxy_key(self):
        self.headers['X-ROVSSA-Proxy']='b'*64
        self.assertEqual(self.c.get('/status',headers=self.headers).status_code,401)

    def test_nonloopback_request_denied(self):
        self.assertEqual(self.c.get('/status',headers=self.headers,environ_overrides={'REMOTE_ADDR':'10.0.0.2'}).status_code,401)

    def test_https_required(self):
        self.headers['X-Forwarded-Proto']='http'
        self.assertEqual(self.c.get('/status',headers=self.headers).status_code,403)

    def test_csrf_origin_and_custom_header(self):
        for origin in ['', 'https://evil.test', 'https://rover.test.evil.test']:
            h=dict(self.headers,Origin=origin)
            self.assertEqual(self.post('/command',{'cmd':'estop'},h).status_code,403)
        h=self.headers.copy();h.pop('X-ROVSSA-Request')
        self.assertEqual(self.post('/command',{'cmd':'estop'},h).status_code,403)

    def test_bad_json_and_content_type(self):
        for value in [[],None,'drive',123,{'cmd':[]}]:
            self.assertEqual(self.post('/command',value).status_code in (400,415),True)
        self.assertEqual(self.c.post('/command',data='{}',headers=self.headers).status_code,415)

    def test_payload_limit(self):
        self.assertEqual(self.post('/command',{'cmd':'drive','data':'x'*17000}).status_code,413)

    def test_status_and_no_cors(self):
        r=self.c.get('/status',headers=self.headers)
        self.assertTrue(r.json['estop']);self.assertFalse(r.json['autonomy_enabled'])
        self.assertNotIn('Access-Control-Allow-Origin',r.headers)

    def test_rc_mode_rejects_network_drive(self):
        self.assertEqual(self.post("/command", {"cmd":"drive"}).status_code,409)

    @unittest.mock.patch.object(server, "NETWORK_DRIVE_ENABLED", True)
    def test_heartbeat_rearm_drive_stop(self):
        r=self.post('/heartbeat',{});epoch=r.json['epoch']
        r=self.post('/command',{'cmd':'estop_release','epoch':epoch})
        self.assertEqual(r.status_code,200);epoch=r.json['epoch']
        self.assertEqual(self.post('/command',{'cmd':'drive','epoch':epoch,'sequence':1,'vx':.2,'omega':0}).status_code,200)
        self.assertTrue(self.post('/command',{'cmd':'estop'}).json['estop'])
        self.assertEqual(self.post('/command',{'cmd':'drive','epoch':epoch,'sequence':2,'vx':.2,'omega':0}).status_code,400)

    def test_previous_server_session_cannot_rearm(self):
        old=server.safety.session
        server.safety=SafetyController()
        self.post('/heartbeat',{})
        self.assertEqual(self.post('/command',{'cmd':'estop_release','epoch':0,'session':old}).status_code,409)

    def test_autonomy_disabled(self):
        self.assertEqual(self.post('/mission',{'objectives':[{'action':'WAIT'}]}).status_code,409)
        self.assertEqual(self.post('/command',{'cmd':'set_mode','mode':'AUTO'}).status_code,409)
        self.assertEqual(self.post('/command',{'cmd':'set_mode','mode':'AI'}).status_code,409)

    def test_sse_authenticated(self):
        r=self.c.get('/telemetry',headers=self.headers,buffered=False)
        first=next(iter(r.response)).decode();r.close()
        self.assertIn('"control"',first);self.assertIn('"fix": false',first)

    def test_no_arm_activation(self):
        class Robot:
            def send_action(self,*args):raise AssertionError('Must not operate')
        server.zmq_arm_thread(Robot())

    def test_config_fails_closed(self):
        from flask import Flask
        from security import install_security
        secret=os.environ.pop('ROVSSA_PROXY_SECRET')
        try:
            with self.assertRaises(RuntimeError):install_security(Flask('bad'))
        finally:os.environ['ROVSSA_PROXY_SECRET']=secret


class ExecutorTests(unittest.TestCase):
    def test_import_has_all_actions(self):
        self.assertTrue(callable(missions._ACTION_MAP['TURN']))
        self.assertTrue(callable(missions._ACTION_MAP['NAVIGATE_FORWARD']))

    def run_mission(self,action):
        class Hardware:
            def send_drive(self,*args):pass
        shutdown=threading.Event()
        missions.start_mission([{'action':action,'params':{}}])
        thread=threading.Thread(target=missions.executor_loop,args=(Hardware(),shutdown),daemon=True)
        thread.start()
        deadline=time.monotonic()+1
        while time.monotonic()<deadline:
            if missions.get_mission_status()['status'] in ('DONE','ERROR'):break
            time.sleep(.01)
        shutdown.set();thread.join(1)
        self.assertFalse(thread.is_alive(),'Executor deadlocked')
        return missions.get_mission_status()['status']

    def test_completion_no_deadlock(self):
        self.assertEqual(self.run_mission('STOP'),'DONE')

    def test_failure_no_deadlock(self):
        self.assertEqual(self.run_mission('NAVIGATE_TO'),'ERROR')


if __name__=='__main__':unittest.main()
