import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

ACTION = Path(__file__).resolve().parents[2] / ".github/actions/publish-docs/publish.py"
SPEC = importlib.util.spec_from_file_location("publish_action", ACTION)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublishActionTest(unittest.TestCase):
    def test_collects_only_tracked_and_unignored_documents(self):
        original = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            os.chdir(temporary)
            self.addCleanup(os.chdir, original)
            subprocess.run(["git", "init", "-q"], check=True)
            Path("docs").mkdir()
            Path(".docsignore").write_text("/docs/*.md\n!/docs/guide.md\n!/docs/legacy.md\n")
            Path(".gitignore").write_text("!/docs/*.md\n/docs/legacy.md\n")
            for file in ("guide.md", "intro.mdx", "private.md", "legacy.md", "new.md", "asset.png"):
                Path("docs", file).write_text("# 文档", encoding="utf-8")
            subprocess.run(
                ["git", "add", "-f", "docs/guide.md", "docs/intro.mdx", "docs/private.md",
                 "docs/legacy.md", "docs/asset.png"],
                check=True,
            )
            files = json.loads(publisher.collect_documents())["files"]
            self.assertEqual([entry["path"] for entry in files], ["guide.md", "intro.mdx"])
            self.assertEqual(files[0]["content"], "# 文档")
            Path(".docsignore").unlink()
            Path("docs/README.md").write_text("# Invalid path")
            subprocess.run(["git", "add", "docs/README.md"], check=True)
            with self.assertRaisesRegex(SystemExit, "Unsupported document path: 'docs/README.md'"):
                publisher.collect_documents()
            subprocess.run(["git", "rm", "--cached", "docs/README.md"], check=True, capture_output=True)
            Path("docs/symlink.md").symlink_to("guide.md")
            subprocess.run(["git", "add", "docs/symlink.md"], check=True)
            with self.assertRaisesRegex(SystemExit, "symlinks"):
                publisher.collect_documents()

    def test_uses_an_audience_bound_oidc_bearer_without_static_credentials(self):
        endpoint = publisher.publish_endpoint("https://zixiaolabs.com/")
        payload = b'{"files":[]}'
        for bad in ("http://zixiaolabs.com", "https://zixiaolabs.com.evil", "https://zixiaolabs.com/login"):
            with self.assertRaises(SystemExit):
                publisher.publish_endpoint(bad)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, "id-token: write"):
                publisher.publish(endpoint, payload)

        env = {
            "ACTIONS_ID_TOKEN_REQUEST_URL": "https://oidc.example.test/token?api-version=2.0",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "fake-request-token",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(publisher, "build_opener") as factory:
            factory.return_value.open.side_effect = [
                io.BytesIO(b'{"value":"fake-oidc-assertion"}'),
                io.BytesIO(b'{"collection":"handbook","count":1}'),
            ]
            publisher.publish(endpoint, payload)
            self.assertIs(factory.call_args.args[0], publisher.NoRedirect)
            get, post = [call.args[0] for call in factory.return_value.open.call_args_list]
            self.assertEqual(parse_qs(urlsplit(get.full_url).query)["audience"], [endpoint])
            self.assertEqual(get.get_header("Authorization"), "Bearer fake-request-token")
            self.assertEqual(post.full_url, endpoint)
            self.assertEqual(post.get_method(), "POST")
            self.assertEqual(post.get_header("Authorization"), "Bearer fake-oidc-assertion")
            self.assertEqual(post.data, payload)
