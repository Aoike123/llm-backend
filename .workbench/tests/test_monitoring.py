import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
exporter=load('monitor_exporter',ROOT/'platforms/monitoring/exporter.py')
controller=load('monitor_controller',ROOT/'platforms/monitoring/controller.py')

class MonitoringTests(unittest.TestCase):
    def test_comfyui_is_required_only_while_h3_or_idle_owns_the_gpu(self):
        def run(model,comfy):
            sample=lambda value:[{'metric':{},'value':[0,str(value)]}]
            def query(expression):
                if 'comfyui' in expression:return sample(comfy)
                if expression=='lab_llm_health':return sample(0)
                return [] if 'vllm' in expression or 'context_limit' in expression else sample(1 if 'health' in expression or 'devices' in expression else 0)
            targets=[{'labels':{'job':job},'health':'up','lastError':''} for job in ('prometheus','host','amd_gpu','gateway')]
            fetch=lambda url:{'data':{'activeTargets':targets}} if 'targets' in url else {'model':model,'values':{'api':1,'comfy':comfy}}
            with patch.object(controller,'fetch',fetch),patch.object(controller,'query',query):
                return controller.report()
        self.assertTrue(run('llm',0)['passed'])
        self.assertEqual(run('llm',0)['comfyui_state'],'stopped-by-design')
        self.assertFalse(run(None,0)['passed'])
        self.assertFalse(run('h3',0)['passed'])
        self.assertTrue(run('h3',1)['passed'])

    def test_amd_sensor_units_and_unavailable_metrics(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            device=root/'class/drm/card1/device'
            hwmon=device/'hwmon/hwmon0'
            hwmon.mkdir(parents=True)
            for filename,value in {'vendor':'0x1002','mem_info_vram_used':'2147483648','mem_info_vram_total':'34359738368','gpu_busy_percent':'32'}.items():
                (device/filename).write_text(value)
            for filename,value in {'temp1_input':'57500','temp1_label':'junction','power1_average':'45123000','freq1_input':'2400000000','fan1_input':'invalid'}.items():
                (hwmon/filename).write_text(value)
            other=root/'class/drm/card0/device'
            other.mkdir(parents=True)
            (other/'vendor').write_text('0x8086')
            with patch.object(exporter,'SYS',root),patch.object(exporter,'PROFILE_FILE',root/'missing'),patch.object(exporter,'urlopen',side_effect=OSError('offline')):
                metrics=exporter.collect().decode()
            self.assertIn('lab_gpu_devices 1',metrics)
            self.assertIn('sensor="junction"} 57.5',metrics)
            self.assertRegex(metrics,r'lab_gpu_power_watts\{[^}]+\} 45.123')
            self.assertRegex(metrics,r'lab_gpu_clock_mhz\{[^}]+\} 2400.0')
            self.assertNotIn('lab_gpu_fan_rpm',metrics)
            self.assertNotIn('lab_gpu_memory_busy_percent',metrics)
            self.assertNotIn('card0',metrics)
            self.assertIn('lab_llm_health 0',metrics)
            self.assertNotIn('lab_llm_context_limit_tokens',metrics)

    def test_live_context_and_configuration_have_distinct_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            profile=root/'profiles.json'
            profile.write_text(json.dumps({'llm-fast':{'args':['--context','123','--max-num-seqs','8','--vision','--thinking','on']}}))
            response=io.BytesIO(json.dumps({'data':[{'id':'model','max_model_len':262144}]}).encode())
            healthy=io.BytesIO(b'');healthy.status=200
            platform_one=io.BytesIO(b'');platform_one.status=200
            platform_two=io.BytesIO(b'');platform_two.status=200
            residency=io.BytesIO(b'{"residency":{"llm":"gpu"}}')
            with patch.object(exporter,'SYS',root),patch.object(exporter,'PROFILE_FILE',profile),patch.object(exporter,'urlopen',side_effect=[healthy,residency,platform_one,platform_two,response]):
                metrics=exporter.collect().decode()
            self.assertIn('lab_llm_context_limit_tokens{model="model"} 262144',metrics)
            self.assertIn('lab_llm_configured_max_sequences 8.0',metrics)
            self.assertIn('lab_llm_configured_vision 1',metrics)
            self.assertIn('lab_llm_configured_thinking 1',metrics)

    def test_initialize_preserves_password_and_uses_locked_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            data=root/'data';here=root/'platform';here.mkdir()
            locked=dict(controller.DEFAULT_IMAGES)
            locked['PYTHON_IMAGE']='python@sha256:example'
            locked['GRAFANA_IMAGE']='grafana@sha256:old'
            data.mkdir()
            (data/'grafana-admin-password').write_text('preserved-secret\n')
            (data/'grafana-admin-password').chmod(0o600)
            (here/'images.lock.json').write_text(json.dumps({'images':locked}))
            with patch.object(controller,'DATA',data),patch.object(controller,'HERE',here),patch.object(controller,'REPORTS',root/'reports'):
                controller.initialize()
                password=(data/'grafana-admin-password').read_text()
                controller.initialize()
                self.assertEqual(password,(data/'grafana-admin-password').read_text())
                self.assertEqual((data/'grafana-admin-password').stat().st_mode & 0o777,0o600)
                self.assertIn('PYTHON_IMAGE=python@sha256:example',(data/'runtime.env').read_text())
                self.assertNotIn(password.strip(),(data/'runtime.env').read_text())
                self.assertNotIn('GRAFANA_IMAGE=',(data/'runtime.env').read_text())
