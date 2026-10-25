import importlib.util,json,subprocess,unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('llm_policy',ROOT/'.workbench/scripts/launch-llm-policy.py')
policy=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy)
spec=importlib.util.spec_from_file_location('llm_policy_ab',ROOT/'.workbench/scripts/test-llm-policy-ab.py')
ab=importlib.util.module_from_spec(spec);spec.loader.exec_module(ab)

class PolicyTests(unittest.TestCase):
    def test_overrides_image_defaults_without_changing_model_command(self):
        original=['docker','run','--rm','--name','paiton-qwen38','pinned-image','serve','/models/target','--max-model-len','262144']
        result=subprocess.CompletedProcess([],0,stdout=json.dumps(original),stderr='')
        with patch.object(policy.subprocess,'run',return_value=result) as dryrun:
            command=policy.command('/launcher.py',['--vision'],{'draft_sample_method':'greedy','draft_rerank':0})
        self.assertIn('PAITON_DFLASH_DRAFT_SAMPLE_METHOD=greedy',command)
        self.assertIn('PAITON_DFLASH_RERANK=0',command)
        self.assertEqual(command[command.index('pinned-image'):],original[5:])
        self.assertNotIn('--enable-sleep-mode',command)
        self.assertIn('--weights',dryrun.call_args.args[0]);self.assertIn('w3a4',dryrun.call_args.args[0])

    def test_incompatible_pool_is_rejected_before_launch(self):
        with patch.object(policy.subprocess,'run') as launch:
            with self.assertRaises(ValueError):policy.command('/launcher.py',[],{'draft_sample_method':'greedy','draft_rerank':128})
            launch.assert_not_called()

    def test_full_draft_rejects_incompatible_head_before_launch(self):
        for pool,overrides in [(128,{'RADIANCE_FAST_DRAFT':'0','RADIANCE_VERIFY_HEAD':'0'}),(0,{'RADIANCE_FAST_DRAFT':'0'})]:
            with patch.object(policy.subprocess,'run') as launch:
                with self.assertRaises(ValueError):policy.command('/launcher.py',[],{'draft_sample_method':'probabilistic','draft_rerank':pool,'environment':overrides})
                launch.assert_not_called()

    def test_invalid_launch_keeps_running_model(self):
        with patch.object(ab.controller,'model_env'),patch.object(ab.launcher,'command',side_effect=ValueError('invalid policy')),patch.object(ab.subprocess,'run') as run:
            with self.assertRaises(ValueError):ab.start_policy({})
            run.assert_not_called()

    def test_successful_experiment_also_restores_production(self):
        with patch.object(ab.probe,'lease',return_value=nullcontext()),patch.object(ab.probe,'metrics',return_value={'vllm:num_requests_running':0}),patch.object(ab,'suite'),patch.object(ab,'start_policy'),patch.object(ab,'correctness'),patch.object(ab,'save'),patch.object(ab,'restore') as restore:
            ab.main();restore.assert_called_once()

if __name__=='__main__':unittest.main()
