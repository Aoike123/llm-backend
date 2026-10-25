import base64
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import URLError

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('image_bridge',ROOT/'platforms/comfyui/custom_nodes/pation_qwen_image21/client.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class ImageBridgeTests(unittest.TestCase):
    def test_edit_transport_uses_json_base64_and_keeps_metrics(self):
        png=b'\x89PNG\r\n\x1a\nfixture'
        reply=io.BytesIO(json.dumps({'data':[{'b64_json':base64.b64encode(png).decode()}],'metrics':{'seconds':4}}).encode())
        with patch.object(bridge,'urlopen',return_value=reply) as transport:
            output,metrics=bridge.generate('Make it blue',1024,42,'edit',png)
        request=transport.call_args.args[0]
        self.assertTrue(request.full_url.endswith('/v1/images/edits'))
        payload=json.loads(request.data)
        self.assertEqual(base64.b64decode(payload['image_b64']),png)
        self.assertEqual(payload['steps'],40)
        self.assertEqual(output,png)
        self.assertEqual(metrics,{'seconds':4})

    def test_unqualified_edit_is_rejected_before_network(self):
        with patch.object(bridge,'urlopen',side_effect=AssertionError('network must not run')):
            for kwargs in [{'mode':'edit','size':2048,'image_png':b'x'},{'mode':'edit'},{'prompt':'x'*513},{'seed':-1}]:
                arguments={'prompt':'test',**kwargs}
                with self.assertRaises(ValueError):bridge.generate(**arguments)

    def test_offline_worker_error_has_actionable_instruction(self):
        with patch.object(bridge,'urlopen',side_effect=URLError('offline')):
            with self.assertRaisesRegex(RuntimeError,'pation-model-qwen-image-21 start'):bridge.generate('test')

    def test_bad_image_payload_is_rejected(self):
        reply=io.BytesIO(json.dumps({'data':[{'b64_json':base64.b64encode(b'not a PNG').decode()}]}).encode())
        with patch.object(bridge,'urlopen',return_value=reply):
            with self.assertRaisesRegex(ValueError,'PNG'):bridge.generate('test')
