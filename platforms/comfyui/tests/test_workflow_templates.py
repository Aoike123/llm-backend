"""Regressions for native graphs, clean layouts and linked-widget serialization."""
import json
from pathlib import Path
import unittest
BASE=Path(__file__).resolve().parents[1]/'workflows'
ENTRIES=json.loads((BASE/'catalog.json').read_text())['workflows']
# Third-party originals are published unmodified, so only native templates follow these layout rules.
NATIVE=[e for e in ENTRIES if e['category']!='第三方工作流']

class TemplateTests(unittest.TestCase):
    def test_v3_combos_keep_values_and_widget_metadata(self):
        for entry in NATIVE:
            if entry['execution'] not in ('h3','wan'):continue
            schema=json.loads((BASE.parent/'custom_nodes/pation_native_h3'/f"{entry['execution']}-schema.json").read_text())
            ui=json.loads((BASE/entry['ui']).read_text())
            for node in ui['nodes']:
                fields=schema.get(node['type'],{}).get('input',{})
                combos={name:definition[1]['options'] for group in ('required','optional') for name,definition in fields.get(group,{}).items() if definition[0]=='COMBO'}
                for name,options in combos.items():
                    inp=next(i for i in node['inputs'] if i['name']==name)
                    self.assertEqual(inp['widget'],{'name':name})
                    if node['type']!='LoadVideo':self.assertTrue(any(value in options for value in node['widgets_values']),(entry['id'],node['type'],name))
                if node['type']=='BasicScheduler':
                    self.assertEqual(node['widgets_values'],['simple',20 if entry['id'].startswith('minimax-h3-multireference') else 8,1.0])

    def test_native_video_templates_keep_editable_sampling_and_decoding(self):
        for entry in NATIVE:
            if entry['execution'] not in ('h3','wan'):continue
            graph=json.loads((BASE/entry['api']).read_text());kinds={n['class_type'] for n in graph.values()}
            self.assertIn('VAEDecode',kinds);self.assertIn('SaveVideo',kinds)
            self.assertNotIn('PationH3Video',kinds);self.assertNotIn('PationWan22Video',kinds)
            self.assertIn('SamplerCustomAdvanced' if entry['execution']=='h3' else 'KSampler',kinds)

    def test_reference_templates_use_ref2va_and_real_video_frames(self):
        entries=[e for e in ENTRIES if e['id'].startswith('minimax-h3-multireference')]
        self.assertEqual(len(entries),3)
        for entry in entries:
            graph=json.loads((BASE/entry['api']).read_text())
            self.assertIn('ref2va',graph['1']['inputs']['unet_name'])
            self.assertEqual(graph['5']['class_type'],'MiniMaxH3ReferenceToVideo')
            self.assertEqual(graph['11']['inputs']['steps'],20)
            self.assertNotIn('6',graph)
            if entry['id'].endswith(('video','mixed')):
                self.assertEqual(graph['200']['class_type'],'LoadVideo')
                self.assertEqual(graph['202']['class_type'],'MiniMaxH3ReferenceVideoFrames')
                self.assertEqual(graph['5']['inputs']['ref_videos.ref_video_0'],['202',0])

    def test_anima_templates_use_native_loaders_and_locked_weights(self):
        entries=[e for e in ENTRIES if e['execution']=='anima']
        self.assertEqual(len(entries),3)
        lock=json.loads((BASE.parent/'models/anima.lock.json').read_text())
        locked={Path(r['destination']).name for r in lock['files']}
        for entry in entries:
            graph=json.loads((BASE/entry['api']).read_text())
            self.assertEqual(entry['category'],'图像生成')
            self.assertIn(graph['1']['inputs']['unet_name'],locked)
            self.assertEqual(graph['2']['inputs'],{'clip_name':'qwen_3_06b_base.safetensors','type':'stable_diffusion','device':'default'})
            self.assertIn(graph['3']['inputs']['vae_name'],locked)
            self.assertEqual(graph['9']['class_type'],'SaveImage')
            sampler=graph['7']['inputs']
            if 'turbo' in graph['1']['inputs']['unet_name']:self.assertEqual((sampler['cfg'],sampler['steps']),(1.0,10))
            else:self.assertEqual((sampler['cfg'],sampler['steps']),(4.0,30))
            if entry['id'].endswith('image'):
                self.assertEqual(sampler['latent_image'],['12',0]);self.assertLess(sampler['denoise'],1)
            else:self.assertEqual(graph['6']['class_type'],'EmptyLatentImage')

    def test_linked_widgets_keep_their_original_serialization_positions(self):
        for name in ('参考视频生视频','图像与视频混合参考'):
            ui=json.loads((BASE/f'ui/视频生成/H3 · {name}.json').read_text())
            node=next(n for n in ui['nodes'] if n['type']=='MiniMaxH3ReferenceVideoFrames')
            self.assertEqual(node['widgets_values'],[24.0,1344])
            links={i['name'] for i in node['inputs'] if i.get('widget') and i['link'] is not None}
            self.assertEqual(links,{'fps'})

    def test_categories_are_flat_and_node_boxes_do_not_overlap(self):
        self.assertEqual({e['category'] for e in ENTRIES},{'图像生成','视频生成','第三方工作流'})
        for entry in NATIVE:
            self.assertEqual(len(Path(entry['ui']).parts),3)
            nodes=json.loads((BASE/entry['ui']).read_text())['nodes']
            for i,a in enumerate(nodes):
                for b in nodes[i+1:]:
                    if 'Note' in (a['type'],b['type']):continue
                    x,y=a['pos'];w,h=a['size'];bx,by=b['pos'];bw,bh=b['size']
                    self.assertFalse(x<bx+bw and x+w>bx and y<by+bh and y+h>by,(entry['id'],a['id'],b['id']))

if __name__=='__main__':unittest.main(verbosity=2)
