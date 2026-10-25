"""Run with ComfyUI's Python; all transports below are fake HTTP services."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from aiohttp import web
from aiohttp.test_utils import TestServer

relay_path=Path('/opt/comfyui/custom_nodes/pation_native_h3/relay.py')
if not relay_path.exists():relay_path=Path(__file__).resolve().parents[1]/'custom_nodes/pation_native_h3/relay.py'
spec=importlib.util.spec_from_file_location('native_relay',relay_path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class NativeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.events=[];self.calls=[];self.graph=None;self.finished=False;self.metrics=[]
        self.queue=types.SimpleNamespace(history={},mutex=threading.RLock())
        self.server=types.SimpleNamespace(prompt_queue=self.queue,number=0,queue_updated=lambda:None,
            send_sync=lambda event,data,sid:self.events.append((event,data)))
        self.relay=module.NativeRelay(self.server,{'h3':{'SaveImage':{'output_node':True},'LoadImage':{},'PaitonH3Optimize':{}}},self.root,self.root,self.root)
        async def acquire(r):self.calls.append('acquire');return web.json_response({'token':'test'})
        async def release(r):self.calls.append('release');return web.json_response({})
        async def metrics(r):self.metrics.append(await r.json());return web.json_response({})
        async def upload(r):
            reader=await r.multipart()
            while (part:=await reader.next()) is not None:
                await part.read()
                if part.name=='image':filename=part.filename
            return web.json_response({'name':filename,'subfolder':''})
        async def prompt(r):self.graph=(await r.json())['prompt'];return web.json_response({'prompt_id':self.pid})
        async def history(r):
            outputs={'2':{'images':[{'filename':'result.png','subfolder':'','type':'output'}]}}
            if self.graph and self.graph.get('1',{}).get('class_type')=='LoadVideo':
                outputs['1']={'images':[{'filename':self.graph['1']['inputs']['file'],'subfolder':'','type':'input'}]}
            return web.json_response({self.pid:{'outputs':outputs,'status':{'status_str':'success','completed':True,'messages':[]}}})
        async def view(r):return web.Response(body=b'real-result')
        async def ws(r):
            socket=web.WebSocketResponse();await socket.prepare(r)
            await socket.send_json({'type':'progress','data':{'value':1,'max':8,'prompt_id':self.pid}})
            async for msg in socket:pass
            return socket
        async def interrupt(r):self.calls.append('interrupt');return web.json_response({})
        app=web.Application()
        app.router.add_post('/workflow-event',metrics)
        for method,path,fn in [('POST','/acquire',acquire),('POST','/release',release),('POST','/upload/image',upload),('POST','/prompt',prompt),('GET','/history/{id}',history),('GET','/view',view),('GET','/ws',ws),('POST','/interrupt',interrupt)]:app.router.add_route(method,path,fn)
        self.http=TestServer(app);await self.http.start_server()
        self.base=str(self.http.make_url('')).rstrip('/')
        self.old_control=module.CONTROL;self.old_workers=module.WORKERS.copy()
        module.CONTROL=self.base;module.WORKERS['h3']=self.base

    async def asyncTearDown(self):
        module.CONTROL=self.old_control;module.WORKERS=self.old_workers
        await self.http.close();self.tmp.cleanup()

    async def test_full_graph_upload_copy_history_and_release(self):
        (self.root/'reference.png').write_bytes(b'png')
        graph={'1':{'class_type':'LoadImage','inputs':{'image':'reference.png'}},'2':{'class_type':'SaveImage','inputs':{'images':['1',0]}},'3':{'class_type':'PaitonH3Optimize','inputs':{}}}
        response=self.relay.submit({'prompt':graph,'client_id':'browser'},'h3');self.pid=response['prompt_id']
        job=self.relay.jobs[self.pid];await job['task']
        self.assertNotEqual(self.graph['1']['inputs']['image'],'reference.png')
        self.assertEqual(self.graph['2'],graph['2'])
        result=self.queue.history[self.pid]
        image=result['outputs']['2']['images'][0]
        self.assertEqual((self.root/image['subfolder']/image['filename']).read_bytes(),b'real-result')
        self.assertEqual(result['prompt'][2],graph)
        self.assertEqual(result['status']['status_str'],'success')
        self.assertEqual(self.calls,['acquire','release'])
        self.assertFalse(self.relay.jobs)
        self.assertEqual([m['phase'] for m in self.metrics],['start','finish'])
        timing=self.metrics[-1]
        self.assertEqual(timing['outcome'],'success')
        self.assertEqual(timing['id'],self.pid)
        self.assertGreaterEqual(timing['seconds'],timing['queue_seconds'])

    async def test_reference_video_upload_uses_file_field_and_preserves_real_video_graph(self):
        (self.root/'reference.mp4').write_bytes(b'video-file')
        self.relay.schemas['h3']['LoadVideo']={}
        graph={'1':{'class_type':'LoadVideo','inputs':{'file':'reference.mp4'}}}
        response=self.relay.submit({'prompt':graph},'h3');self.pid=response['prompt_id']
        await self.relay.jobs[self.pid]['task']
        self.assertNotEqual(self.graph['1']['inputs']['file'],'reference.mp4')
        self.assertTrue(self.graph['1']['inputs']['file'].endswith('.mp4'))
        self.assertNotIn('image',self.graph['1']['inputs'])
        self.assertEqual(self.queue.history[self.pid]['outputs']['1']['images'][0],{'filename':'reference.mp4','subfolder':'','type':'input'})
        self.assertEqual(self.calls,['acquire','release'])

    async def test_validation_error_releases_lease_and_preserves_error_history(self):
        graph={'1':{'class_type':'LoadImage','inputs':{'image':'missing.png'}}}
        response=self.relay.submit({'prompt':graph},'h3');self.pid=response['prompt_id']
        await self.relay.jobs[self.pid]['task']
        self.assertEqual(self.calls,['acquire','release'])
        self.assertEqual(self.queue.history[self.pid]['status']['status_str'],'error')
        self.assertTrue(any(event=='execution_error' for event,_ in self.events))
        self.assertEqual(self.metrics[-1]['outcome'],'error')

    async def test_cancel_before_acquire_never_submits_and_releases(self):
        response=self.relay.submit({'prompt':{'1':{'class_type':'SaveImage','inputs':{}}}},'h3');self.pid=response['prompt_id']
        job=self.relay.jobs[self.pid];await self.relay.cancel([self.pid]);await job['task']
        self.assertIsNone(self.graph);self.assertEqual(self.calls,['acquire','release'])

    async def test_binary_preview_preserves_protocol_header(self):
        from aiohttp import WSMsgType
        import struct
        sent=[]
        async def send_bytes(event,data,sid):sent.append((event,data,sid))
        self.server.send_bytes=send_bytes
        class Socket:
            def __aiter__(self):
                async def messages():
                    yield types.SimpleNamespace(type=WSMsgType.BINARY,data=struct.pack('>I',1)+b'preview')
                return messages()
        await self.relay.relay_events(None,Socket(),self.base,{'id':'id','client':'browser'})
        self.assertEqual(sent,[(1,b'preview','browser')])

    async def test_reference_names_preserve_cache_until_content_changes(self):
        from aiohttp import ClientSession
        path=self.root/'reference.png';path.write_bytes(b'first')
        async def uploaded(session):
            graph={'1':{'class_type':'LoadImage','inputs':{'image':'reference.png'}}}
            await self.relay.upload_inputs(session,self.base,graph)
            return graph['1']['inputs']['image']
        async with ClientSession() as session:
            first=await uploaded(session);self.assertEqual(first,await uploaded(session))
            path.write_bytes(b'changed');self.assertNotEqual(first,await uploaded(session))

    async def test_distinct_output_subfolders_do_not_overwrite(self):
        from aiohttp import ClientSession
        job={'id':'test-id','files':{}}
        async with ClientSession() as session:
            first=await self.relay.copy_outputs(session,self.base,{'filename':'same.png','type':'output','subfolder':'one'},job)
            second=await self.relay.copy_outputs(session,self.base,{'filename':'same.png','type':'output','subfolder':'two'},job)
        self.assertNotEqual(first['subfolder'],second['subfolder'])
        for value in (first,second):self.assertTrue((self.root/value['subfolder']/value['filename']).exists())

    async def test_unknown_node_and_mixed_workers_rejected(self):
        with self.assertRaises(ValueError):self.relay.submit({'prompt':{'1':{'class_type':'MadeUp','inputs':{}}}},'h3')
        with self.assertRaises(ValueError):module.native_model({'1':{'class_type':'PaitonH3Optimize'},'2':{'class_type':'PaitonWanBaseLoader'}})
        self.assertIsNone(module.native_model({'1':{'class_type':'PationH3Video'}}))
        with self.assertRaises(ValueError):module.safe_relative('../outside.png')

if __name__=='__main__':unittest.main(verbosity=2)
