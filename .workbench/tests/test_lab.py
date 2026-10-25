import base64
import importlib.machinery
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


lab = load("lab_module", ROOT / "engines/shared/paiton/controller.py")
exporter = load("geneval_export", ROOT / ".workbench/scripts/geneval_export.py")
dispatcher = load("dispatcher", ROOT / ".workbench/cli.py")


class LabTests(unittest.TestCase):
    def test_model_deployment_routes_quantization_profile(self):
        with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
            dispatcher.main(["pation-model-qwen38-27b-w3a4", "start", "w3a4"])
            self.assertEqual(execute.call_args.args[0][-2:], ["start", "llm-fast"])

    def test_global_stop_is_not_limited_to_default_llm(self):
        with patch.object(dispatcher.subprocess, "run") as execute:
            execute.return_value.returncode = 0
            dispatcher.main(["stop"])
            self.assertNotIn("--profile", execute.call_args.args[0])

    def test_model_deployment_stop_is_scoped(self):
        with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
            dispatcher.main(["pation-model-qwen38-27b-mxfp4", "stop", "mxfp4"])
            self.assertEqual(execute.call_args.args[0][-3:], ["stop", "--profile", "llm"])

    def test_model_deployment_requires_supported_profile(self):
        with patch.object(dispatcher.subprocess, "run", side_effect=AssertionError("must not launch")):
            with self.assertRaisesRegex(RuntimeError, "请选择运行配置"):
                dispatcher.main(["pation-model-qwen38-27b-w3a4", "start", "int8"])

    def test_named_deployment_default_uses_correct_quantization(self):
        for name, profile in [("w3a4", "llm-fast"), ("mxfp4", "llm")]:
            with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
                dispatcher.main(["pation-model-qwen38-27b-" + name, "start"])
                self.assertEqual(execute.call_args.args[0][-2:], ["start", profile])

    def test_media_entrypoint_selects_image_profile(self):
        with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
            self.assertEqual(dispatcher.main(["flux", "start"]), 0)
            self.assertEqual(execute.call_args.args[0][-2:], ["start", "image"])

    def test_media_stop_is_scoped_to_selected_profile(self):
        with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
            dispatcher.main(["minimax-h3", "stop"])
            self.assertEqual(execute.call_args.args[0][-3:], ["stop", "--profile", "video-audio"])

    def test_media_help_does_not_become_launcher_extra_argument(self):
        with patch.object(dispatcher.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as execute:
            dispatcher.main(["flux", "start", "--help"])
            self.assertEqual(execute.call_args.args[0][-2:], ["start", "--help"])

    def test_does_not_select_unrelated_containers(self):
        output = "postgres|other\npaiton-qwen38|\nworker|paiton-h3\n"
        with patch.object(lab, "run", return_value=subprocess.CompletedProcess([], 0, output)):
            self.assertEqual(lab.active_containers(), ["paiton-qwen38", "worker"])

    def test_rejects_second_gpu_workload(self):
        with patch.object(lab, "active_containers", return_value=["paiton-qwen38"]):
            with self.assertRaisesRegex(RuntimeError, "先执行 ./lab stop"):
                lab.require_idle()

    def test_sha_verification_can_run_in_model_directory(self):
        with patch.object(lab.subprocess, "run") as execute:
            lab.run(["sha256sum", "-c", "SHA256SUMS"], cwd="/tmp/model-check")
            self.assertEqual(execute.call_args.kwargs["cwd"], "/tmp/model-check")

    def test_fetch_reuses_local_models_without_download_environment(self):
        with patch.object(lab, "LOCAL_MODELS", {"PAITON_TARGET_DIR": "/archive/target", "PAITON_DRAFT_DIR": "/archive/draft"}), \
             patch.object(lab, "check_local_model", side_effect=lambda name: lab.LOCAL_MODELS[name]), \
             patch.object(lab, "tools_python", side_effect=AssertionError("must not require download tools")), \
             patch.object(lab, "run", side_effect=AssertionError("must not download")), \
             patch.object(lab.sys, "argv", ["lab", "fetch"]):
            self.assertEqual(lab.main(), 0)

    def test_local_model_rejects_missing_index_shard(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            for name in ("config.json", "tokenizer.json"):
                (path / name).write_text("{}")
            (path / "present.safetensors").write_bytes(b"test")
            (path / "model.safetensors.index.json").write_text('{"weight_map":{"tensor":"missing.safetensors"}}')
            with patch.dict(lab.ENV, {"PAITON_TARGET_DIR": tmp}):
                with self.assertRaisesRegex(RuntimeError, "权重缺失"):
                    lab.check_local_model("PAITON_TARGET_DIR")

    def test_geneval_export_records_protocol_and_distinct_seeds(self):
        requests = []

        def response(request, timeout):
            requests.append(json.loads(request.data))
            return io.BytesIO(json.dumps({"data": [{"b64_json": base64.b64encode(b"\x89PNG\r\n\x1a\ntest").decode()}]}).encode())

        with tempfile.TemporaryDirectory() as tmp:
            metadata = Path(tmp) / "prompts.jsonl"
            metadata.write_text(json.dumps({"tag": "single_object", "prompt": "a bench", "include": [{"class": "bench", "count": 1}]}) + "\n")
            output = Path(tmp) / "samples"
            with patch.object(exporter, "urlopen", side_effect=response):
                exporter.export(metadata, output, "http://local-test/images", samples=2)
            self.assertEqual([r["seed"] for r in requests], [42, 43])
            self.assertEqual(len(list((output / "00000/samples").glob("*.png"))), 2)
            self.assertEqual(json.loads((output / "00000/metadata.jsonl").read_text())["tag"], "single_object")
            self.assertNotIn("b64_json", json.loads((output / "00000/receipt-00000.json").read_text())["data"][0])
            with self.assertRaises(FileExistsError):
                exporter.export(metadata, output, "http://local-test/images")

    def test_geneval_does_not_save_non_image_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            metadata = Path(tmp) / "prompts.jsonl"
            metadata.write_text('{"prompt":"a bench"}\n')
            fake = io.BytesIO(json.dumps({"data": [{"b64_json": base64.b64encode(b"error page").decode()}]}).encode())
            with patch.object(exporter, "urlopen", return_value=fake):
                with self.assertRaisesRegex(ValueError, "没有返回 PNG"):
                    exporter.export(metadata, Path(tmp) / "out", "http://local-test/images")
            self.assertFalse(list((Path(tmp) / "out").rglob("*.png")))


if __name__ == "__main__":
    unittest.main()
