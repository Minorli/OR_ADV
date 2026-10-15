from pathlib import Path
import hashlib
import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name,ROOT/"scripts"/(name+".py"))
    result=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

class IntegrityTests(unittest.TestCase):
    def test_changed_file_detected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            (p/"note.md").write_text("before")
            digest=hashlib.sha256(b"before").hexdigest()
            (p/"manifest.json").write_text(json.dumps({"files":{"note.md":digest}}))
            verifier=module("verify_bundle")
            self.assertEqual([],verifier.verify(p))
            (p/"note.md").write_text("after")
            self.assertTrue(verifier.verify(p))
    def test_manifest_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)
            (p/"manifest.json").write_text(json.dumps({"files":{"../outside":"0"*64}}))
            self.assertIn("unsafe manifest path",module("verify_bundle").verify(p))
    def test_fixture_has_no_seat_corruption(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle"
            shutil.copytree(ROOT,p,ignore=shutil.ignore_patterns("node_modules","__pycache__","work",".git","dist","oradv-linux-handoff-v1.0.0","*.zip","secrets*.txt","*.key","*.pem","local.json",".env*"))
            data=json.loads((p/"fixtures/demo.json").read_text())
            data["activities"][0]["reservedSeats"]=8
            (p/"fixtures/demo.json").write_text(json.dumps(data))
            self.assertTrue(any("capacity mismatch" in x for x in module("validate_package").validate(p)))

@unittest.skipUnless(shutil.which("node"),"Node unavailable")
class CiPreflightTests(unittest.TestCase):
    def seal(self,app):
        meta=json.loads((app/"build-meta.json").read_text())
        meta["artifactHashes"]={p.relative_to(app).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in sorted(app.rglob("*")) if p.is_file() and p.name!="build-meta.json"}
        (app/"build-meta.json").write_text(json.dumps(meta))
    def prepare(self,p):
        scripts=p/"scripts"; scripts.mkdir()
        shutil.copyfile(ROOT/"scripts/wechat-ci.cjs",scripts/"wechat-ci.cjs")
        shutil.copyfile(ROOT/"scripts/asset-inventory.cjs",scripts/"asset-inventory.cjs")
        app=p/"app/miniprogram"; app.mkdir(parents=True)
        (app/"pages/home").mkdir(parents=True)
        appid="wx0000000000000000"
        (app/"project.config.json").write_text(json.dumps({"appid":appid,"miniprogramRoot":"./"}))
        (app/"app.json").write_text(json.dumps({"pages":["pages/home/index"]}))
        (app/"app.js").write_text("App({})")
        (app/"pages/home/index.js").write_text("Page({})")
        (app/"pages/home/index.wxml").write_text("<view>local preflight fixture</view>")
        runtime={"mode":"cloud","appId":appid,"envId":"fixture-test","target":"test","version":"test.1"}
        (app/"build-meta.json").write_text(json.dumps(runtime))
        (app/"runtime-config.json").write_text(json.dumps(runtime))
        self.seal(app)
        c={"appId":appid,"version":"test.1","robot":1,"projectPath":"app/miniprogram",
           "privateKeyPath":str(p.parent/"nonexistent-test-key"),
           "environments":{"test":{"envId":"fixture-test"},"production":{"envId":"fixture-prod"}}}
        config=p/"local.json"; config.write_text(json.dumps(c))
        return scripts/"wechat-ci.cjs",config,c,app
    def run_script(self,script,config,*args):
        return subprocess.run(["node",str(script),"preview","--env","test","--config",str(config),*args],capture_output=True,text=True)
    def test_dry_run_never_requires_sdk_or_key(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            r=self.run_script(script,config)
            self.assertEqual(0,r.returncode,r.stderr)
            self.assertIn("DRY_RUN",r.stdout)
            self.assertIn("No key read, SDK loaded",r.stdout)
    def test_wrong_env_build_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            c["environments"]["test"]["envId"]="different"
            config.write_text(json.dumps(c))
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Build metadata differs",r.stderr)
    def test_execute_missing_key_fails_before_sdk(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            r=self.run_script(script,config,"--execute")
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Upload key file is not available",r.stderr)
    def test_mock_runtime_cannot_be_uploaded_as_cloud(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            runtime=json.loads((app/"runtime-config.json").read_text())
            runtime["mode"]="mock"
            (app/"runtime-config.json").write_text(json.dumps(runtime))
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Runtime configuration differs",r.stderr)
    def test_mock_preview_requires_explicit_flag_and_no_cloud_environment(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            c["environments"]["test"]["envId"]=""
            config.write_text(json.dumps(c))
            for name in ("runtime-config.json","build-meta.json"):
                runtime=json.loads((app/name).read_text())
                runtime.update(mode="mock",envId="")
                (app/name).write_text(json.dumps(runtime))
            self.seal(app)
            self.assertNotEqual(0,self.run_script(script,config).returncode)
            result=self.run_script(script,config,"--mock")
            self.assertEqual(0,result.returncode,result.stderr)
            rejected=subprocess.run(["node",str(script),"upload","--env","test","--config",str(config),"--mock"],capture_output=True,text=True)
            self.assertNotEqual(0,rejected.returncode)
            self.assertIn("Mock mode",rejected.stderr)
    def test_compile_output_is_required(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            (app/"app.js").unlink()
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Compiled app.js missing",r.stderr)
    def test_tampered_compiled_output_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            (app/"app.js").write_text("App({oldEnvironment:'other'})")
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Compiled assets differ",r.stderr)
    def test_private_asset_and_symlink_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            canary=Path(d)/"canary.json";canary.write_text("harmless fixture")
            link=app/"image.json";link.symlink_to(canary)
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Symbolic links",r.stderr)
            link.unlink()
            (app/"secret-config.json").write_text("harmless fixture")
            r=self.run_script(script,config)
            self.assertNotEqual(0,r.returncode)
            self.assertIn("Private or credential filename",r.stderr)
    def test_zip_packager_uses_verified_inventory(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            shutil.copyfile(ROOT/"scripts/pack-preview.py",p/"scripts/pack-preview.py")
            for name in ("runtime-config.json","build-meta.json"):
                runtime=json.loads((app/name).read_text())
                runtime.update(mode="mock",envId="")
                (app/name).write_text(json.dumps(runtime))
            self.seal(app)
            (app/"project.private.config.json").write_text("{}")
            result=subprocess.run(["python3",str(p/"scripts/pack-preview.py")],capture_output=True,text=True)
            self.assertEqual(0,result.returncode,result.stderr)
            from zipfile import ZipFile
            with ZipFile(p/"dist/OR_ADV-mock-preview.zip") as archive:
                self.assertFalse(any("private" in name for name in archive.namelist()))
            (app/"secret-config.json").write_text("harmless fixture")
            result=subprocess.run(["python3",str(p/"scripts/pack-preview.py")],capture_output=True,text=True)
            self.assertNotEqual(0,result.returncode)
            self.assertIn("Private or credential filename",result.stderr)
    def test_sdk_open_handles_exit_after_failure_without_raw_error(self):
        self.check_sdk_open_handles(failure=True)
    def test_sdk_open_handles_exit_after_success(self):
        self.check_sdk_open_handles(failure=False)
    def check_sdk_open_handles(self,failure):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"bundle";p.mkdir()
            script,config,c,app=self.prepare(p)
            key=Path(d)/"canary-upload-key"
            key.write_text("harmless synthetic fixture, not a real private key")
            key.chmod(0o600)
            c.update(privateKeyPath=str(key),actualEgressIp="203.0.113.10")
            config.write_text(json.dumps(c))
            sdk=p/"node_modules/miniprogram-ci";sdk.mkdir(parents=True)
            body="throw new Error('REMOTE_CREDENTIAL=canary-secret-do-not-print')" if failure else "return {}"
            (sdk/"index.js").write_text("setInterval(()=>{},1000); exports.Project=class {}; exports.preview=async()=>{"+body+"};")
            result=subprocess.run(["node",str(script),"preview","--env","test","--config",str(config),"--execute"],
                                  capture_output=True,text=True,timeout=3)
            self.assertEqual(2 if failure else 0,result.returncode,result.stderr)
            self.assertNotIn("canary-secret",result.stdout+result.stderr)
            self.assertIn("Official CI execution failed" if failure else "Preview created",result.stderr if failure else result.stdout)

if __name__=="__main__":
    unittest.main()
