"""Run an editable native graph as one scheduled GPU job, retaining ComfyUI I/O."""
import asyncio
import copy
import json
import time
import struct
import uuid
import logging
import hashlib
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, WSMsgType, web

WORKERS = {'h3': 'http://127.0.0.1:8190', 'wan': 'http://127.0.0.1:8192'}
CONTROL = 'http://127.0.0.1:18990'


def native_model(graph):
    """Only actual native model nodes select a worker; bridge pipelines stay local."""
    models = set()
    for node in graph.values():
        kind = node.get('class_type', '')
        if kind.startswith(('PaitonH3', 'MiniMaxH3')):
            models.add('h3')
        if kind.startswith('PaitonWan') or kind == 'Wan22ImageToVideoLatent':
            models.add('wan')
        if kind == 'UNETLoader' and 'minimax_h3' in str(node.get('inputs', {}).get('unet_name', '')):
            models.add('h3')
    if len(models) > 1:
        raise ValueError('一张原生图只能使用一个 GPU 工作环境；跨模型请使用组合流程。')
    return next(iter(models), None)


def safe_relative(value):
    path = Path(value)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Invalid workflow file path')
    return path


class NativeRelay:
    def __init__(self, server, schemas, input_dir, output_dir, temp_dir):
        self.server, self.schemas = server, schemas
        self.input_dir, self.output_dir, self.temp_dir = map(Path, (input_dir, output_dir, temp_dir))
        self.jobs = {}
        self.schema_checked_at = 0

    def queue_items(self):
        running, pending = [], []
        for job in list(self.jobs.values()):
            (running if job['submitted'] else pending).append(job['item'])
        return running, pending

    async def request(self, session, base, path, data=None, timeout=30):
        async with session.request('GET' if data is None else 'POST', base + path,
                                   json=data, timeout=ClientTimeout(total=timeout)) as response:
            if response.status >= 400:
                raise RuntimeError(f'{path}: HTTP {response.status}: {(await response.text())[:1200]}')
            raw = await response.read()
            return json.loads(raw) if raw else {}

    async def refresh_live_schemas(self):
        # Query only existing workers. Opening a node selector never starts/switches a model.
        if time.monotonic() - self.schema_checked_at < 5:
            return
        self.schema_checked_at = time.monotonic()
        async with ClientSession() as session:
            async def refresh(model):
                try:
                    live = await self.request(session, WORKERS[model], '/object_info', timeout=2)
                    if isinstance(live, dict) and 'SaveVideo' in live:
                        self.schemas[model] = live
                except Exception:
                    pass  # offline workers retain the last known schema
            await asyncio.gather(*(refresh(model) for model in self.schemas))

    async def upload_inputs(self, session, base, graph, job=None):
        from aiohttp import FormData
        for node in graph.values():
            if node['class_type'] not in ('LoadImage', 'LoadImageMask', 'PaitonWanInputImage', 'PaitonH3InputImage', 'LoadVideo'):
                continue
            field = 'file' if node['class_type'] == 'LoadVideo' else 'image'
            filename = node['inputs'].get(field, '(none)')
            if filename == '(none)':
                continue
            annotated = filename.endswith(' [temp]')
            relative = safe_relative(filename[:-7] if annotated else filename.removesuffix(' [input]'))
            directory = self.temp_dir if annotated else self.input_dir
            source = (directory / relative).resolve()
            if not source.is_relative_to(directory.resolve()):
                raise ValueError('Reference media is outside the input directory')
            form = FormData()
            # Stable content names preserve native LoadImage/conditioning caches.
            # A changed file gets a new name; identical bytes can safely be reused.
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            form.add_field('overwrite', 'true')
            with source.open('rb') as stream:
                form.add_field('image', stream, filename='native-' + digest + source.suffix,
                               content_type='application/octet-stream')
                async with session.post(base + '/upload/image', data=form) as response:
                    response.raise_for_status()
                    uploaded = await response.json()
            node['inputs'][field] = '/'.join(filter(None, [uploaded.get('subfolder'), uploaded['name']]))
            if job is not None:
                params={'filename':uploaded['name'],'subfolder':uploaded.get('subfolder') or '', 'type':'input'}
                job.setdefault('input_files',{})[json.dumps(params,sort_keys=True)]={
                    'filename':relative.name,'subfolder':'' if str(relative.parent)=='.' else relative.parent.as_posix(),
                    'type':'temp' if annotated else 'input'}

    async def copy_outputs(self, session, base, value, job):
        if isinstance(value, list):
            return [await self.copy_outputs(session, base, v, job) for v in value]
        if not isinstance(value, dict):
            return value
        if isinstance(value.get('filename'), str) and value.get('type')=='input':
            params={'filename':value['filename'],'subfolder':value.get('subfolder') or '', 'type':'input'}
            return job.get('input_files',{}).get(json.dumps(params,sort_keys=True),value)
        if isinstance(value.get('filename'), str) and value.get('type') in ('output', 'temp'):
            params = {k: value[k] for k in ('filename', 'subfolder', 'type') if k in value}
            key = json.dumps(params, sort_keys=True)
            if key not in job['files']:
                name = safe_relative(value['filename']).name
                folder = Path('native') / job['id'] / safe_relative(value.get('subfolder') or '')
                directory = self.output_dir if value['type'] == 'output' else self.temp_dir
                target = directory / folder / name
                target.parent.mkdir(parents=True, exist_ok=True)
                async with session.get(base + '/view', params=params) as response:
                    response.raise_for_status()
                    with target.open('wb') as stream:
                        async for chunk in response.content.iter_chunked(1024 * 1024):
                            stream.write(chunk)
                job['files'][key] = {**value, 'filename': name, 'subfolder': folder.as_posix()}
            return job['files'][key]
        return {k: await self.copy_outputs(session, base, v, job) for k, v in value.items()}

    async def renew(self, session, token):
        while True:
            await asyncio.sleep(30)
            await self.request(session, CONTROL, '/renew', {'token': token})

    async def report_metrics(self, session, job, phase, **timing):
        event = {'id': job['id'], 'model': job['model'], 'phase': phase, **timing}
        for attempt in range(3):
            try:
                await self.request(session, CONTROL, '/workflow-event', event, 5)
                return
            except Exception as error:
                if attempt == 2:
                    logging.warning('Native workflow metrics %s: %s', job['id'], error)
                else:
                    await asyncio.sleep(.5)

    async def relay_events(self, session, socket, base, job):
        async for message in socket:
            if message.type == WSMsgType.TEXT:
                event = json.loads(message.data)
                kind, data = event.get('type'), event.get('data', {})
                # Worker-global status must not replace the public queue count.
                if kind == 'status' or data.get('prompt_id') not in (None, job['id']):
                    continue
                if kind == 'executed' and 'output' in data:
                    data['output'] = await self.copy_outputs(session, base, data['output'], job)
                if kind == 'executing' and data.get('node') is None:
                    continue  # send completion after history and output files are committed
                self.server.send_sync(kind, data, job['client'])
            elif message.type == WSMsgType.BINARY:
                # Binary frames already contain ComfyUI's preview event header.
                await self.server.send_bytes(struct.unpack('>I', message.data[:4])[0], message.data[4:], job['client'])

    def submit(self, payload, model):
        graph = payload['prompt']
        bridges = {n.get('class_type', '') for n in graph.values() if n.get('class_type', '').startswith('Pation') or n.get('class_type') == 'PaitonFlux2'}
        if bridges:
            raise ValueError('原生图不能混用其他部署的 API 生成节点；请使用组合流程。')
        unknown = {n['class_type'] for n in graph.values()} - self.schemas[model].keys()
        if unknown:
            raise ValueError('该原生工作环境未安装这些节点：' + ', '.join(sorted(unknown)) + '。跨模型 API 节点请放入组合流程。')
        pid = payload.get('prompt_id') or str(uuid.uuid4())
        if str(uuid.UUID(pid)) != pid:
            raise ValueError('prompt_id must be a canonical UUID')
        if pid in self.jobs or pid in self.server.prompt_queue.history:
            raise ValueError('Duplicate prompt_id')
        number = float(payload.get('number', -self.server.number if payload.get('front') else self.server.number))
        self.server.number += 1
        extra = copy.deepcopy(payload.get('extra_data', {}))
        if payload.get('client_id'):
            extra['client_id'] = payload['client_id']
        extra['create_time'] = int(time.time() * 1000)
        outputs = [key for key, node in graph.items() if self.schemas[model][node['class_type']].get('output_node')]
        item = (number, pid, copy.deepcopy(graph), extra, outputs)
        job = {'id': pid, 'model': model, 'client': payload.get('client_id'), 'payload': payload,
               'item': item, 'submitted': False, 'cancelled': False, 'files': {}, 'started': time.monotonic()}
        self.jobs[pid] = job
        job['task'] = asyncio.create_task(self.run(job))
        self.server.queue_updated()
        return {'prompt_id': pid, 'number': number, 'node_errors': {}}

    async def run(self, job):
        token = None
        heartbeat = events = None
        queue_seconds = None
        outcome = 'error'
        async with ClientSession(timeout=ClientTimeout(total=1800)) as session:
            try:
                await self.report_metrics(session, job, 'start')
                ticket = await self.request(session, CONTROL, '/acquire', {'model': job['model'], 'timeout': 900}, 930)
                token = ticket['token']
                queue_seconds = time.monotonic() - job['started']
                heartbeat = asyncio.create_task(self.renew(session, token))
                if job['cancelled']:
                    raise RuntimeError('工作流已取消')
                base = WORKERS[job['model']]
                graph = copy.deepcopy(job['payload']['prompt'])
                await self.upload_inputs(session, base, graph, job)
                client = str(uuid.uuid4())
                async with session.ws_connect(base + '/ws', params={'clientId': client}, heartbeat=20) as socket:
                    events = asyncio.create_task(self.relay_events(session, socket, base, job))
                    data = {**job['payload'], 'prompt': graph, 'client_id': client, 'prompt_id': job['id']}
                    await self.request(session, base, '/prompt', data)
                    job['submitted'] = True
                    self.server.queue_updated()
                    for _ in range(7200):
                        if heartbeat.done():
                            heartbeat.result()  # never hide a lost lease renewal
                        if job['cancelled']:
                            await self.request(session, base, '/interrupt', {'prompt_id': job['id']})
                        history = await self.request(session, base, '/history/' + job['id'])
                        if job['id'] in history:
                            entry = history[job['id']]
                            entry['outputs'] = await self.copy_outputs(session, base, entry.get('outputs', {}), job)
                            entry['prompt'] = job['item']
                            self.store(job['id'], entry)
                            outcome = 'success' if entry.get('status', {}).get('status_str') == 'success' else 'error'
                            break
                        await asyncio.sleep(.5)
                    else:
                        raise RuntimeError('原生工作流超过一小时；租约在后端空闲前保持保护')
            except Exception as error:
                data = {'prompt_id': job['id'], 'node_id': '', 'node_type': 'NativeWorkflow',
                        'exception_message': str(error), 'exception_type': type(error).__name__,
                        'traceback': [], 'executed': [], 'current_inputs': {}, 'current_outputs': []}
                self.server.send_sync('execution_error', data, job['client'])
                self.store(job['id'], {'prompt': job['item'], 'outputs': {},
                    'status': {'status_str': 'error', 'completed': False, 'messages': [['execution_error', data]]}})
            finally:
                for task in (events, heartbeat):
                    if task:
                        task.cancel()
                        try:
                            await task
                        except (asyncio.CancelledError, Exception):
                            pass
                if token:
                    try:
                        await self.request(session, CONTROL, '/release', {'token': token}, 15)
                    except Exception:
                        pass  # scheduler verifies backend idle before reclaiming an expired lease
                elapsed = time.monotonic() - job['started']
                await self.report_metrics(session, job, 'finish', outcome=outcome, seconds=elapsed,
                                          queue_seconds=queue_seconds if queue_seconds is not None else elapsed,
                                          finished_at=time.time())
                self.jobs.pop(job['id'], None)
                self.server.send_sync('executing', {'node': None, 'prompt_id': job['id']}, job['client'])
                self.server.queue_updated()

    def store(self, pid, entry):
        queue = self.server.prompt_queue
        with queue.mutex:
            queue.history[pid] = entry
            while len(queue.history) > 10000:
                queue.history.pop(next(iter(queue.history)))

    async def cancel(self, ids):
        matched = False
        for job in list(self.jobs.values()):
            if ids is None or job['id'] in ids:
                job['cancelled'] = True
                matched = True
                if job['submitted']:
                    async with ClientSession() as session:
                        await self.request(session, WORKERS[job['model']], '/interrupt', {'prompt_id': job['id']})
        return matched

    def install(self):
        queue = self.server.prompt_queue
        for name in ('get_current_queue', 'get_current_queue_volatile'):
            original = getattr(queue, name)
            def combined(original=original):
                running, pending = original()
                remote_running, remote_pending = self.queue_items()
                return running + remote_running, pending + remote_pending
            setattr(queue, name, combined)
        remaining = queue.get_tasks_remaining
        queue.get_tasks_remaining = lambda: remaining() + len(self.jobs)

        @web.middleware
        async def middleware(request, handler):
            path = request.path.removeprefix('/api') if request.path.startswith('/api/') and not request.path.startswith('/api/jobs') else request.path
            if request.method == 'GET' and (path == '/object_info' or path.startswith('/object_info/')):
                response = await handler(request)
                await self.refresh_live_schemas()
                data = json.loads(response.body)
                # Publish worker-native node schemas without importing GPU modules into CPU ComfyUI.
                for model, schemas in self.schemas.items():
                    for kind, schema in schemas.items():
                        if kind.startswith(('PaitonH3', 'MiniMaxH3', 'PaitonWan')) or kind == 'Wan22ImageToVideoLatent' or model == 'h3' and kind in ('UNETLoader', 'CLIPLoader', 'LoraLoaderBypassModelOnly'):
                            if path == '/object_info' or path == '/object_info/' + kind:
                                data[kind] = copy.deepcopy(schema)
                                if kind in ('PaitonWanInputImage', 'PaitonH3InputImage'):
                                    local = data.get('LoadImage', {}).get('input', {}).get('required', {}).get('image', [[]])[0]
                                    data[kind]['input']['required']['image'][0] = ['(none)', *local]
                return web.json_response(data)
            if request.method == 'POST' and path == '/prompt':
                try:
                    payload = await request.json()
                    graph = payload.get('prompt')
                    if isinstance(graph, dict):
                        model = native_model(graph)
                        if model:
                            return web.json_response(self.submit(payload, model))
                except (ValueError, KeyError, TypeError, AttributeError) as error:
                    return web.json_response({'error': {'type': 'native_workflow', 'message': str(error)}, 'node_errors': {}}, status=400)
            if request.method == 'POST' and (path in ('/interrupt', '/queue', '/api/jobs/cancel') or path.startswith('/api/jobs/') and path.endswith('/cancel')):
                try:
                    payload = await request.json()
                except (ValueError, TypeError):
                    payload = {}
                if path == '/interrupt':
                    pid = payload.get('prompt_id')
                    matched = await self.cancel([pid] if pid else None)
                    if matched and pid:
                        return web.json_response({})
                elif path == '/queue':
                    ids = payload.get('delete', [])
                    if payload.get('clear'):
                        ids += [pid for pid, job in self.jobs.items() if not job['submitted']]
                    await self.cancel(ids)
                else:
                    ids = payload.get('job_ids') or [path.split('/')[-2]]
                    if await self.cancel(ids):
                        return web.json_response({'cancelled': True})
            return await handler(request)
        self.server.app.middlewares.append(middleware)
