"""Upload tracked docs as one public snapshot, using one job-scoped OIDC token."""

import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

FORMATS = {".md", ".mdx", ".html"}
DOCUMENT_PATH = re.compile(r"(?:[a-z0-9][a-z0-9_-]*/)*[a-z0-9][a-z0-9_-]*\.(?:mdx|md|html)")


class NoRedirect(HTTPRedirectHandler):
    # Never forward Authorization to another host or endpoint.
    def redirect_request(self, *args, **kwargs):
        return None


def publish_endpoint(raw_origin):
    origin = urlsplit(raw_origin)
    if (
        origin.scheme != "https"
        or not re.fullmatch(r"(?:[a-z0-9-]+\.)*zixiaolabs\.com", origin.netloc)
        or origin.path not in ("", "/")
        or origin.query
        or origin.fragment
    ):
        raise SystemExit("portal-origin must use HTTPS on zixiaolabs.com or its subdomains.")
    return f"https://{origin.netloc}/api/publish"


def ignored_paths(paths, cwd=None):
    ignored = subprocess.run(
        ["git", "-c", f"core.excludesFile={os.devnull}",
         "check-ignore", "--no-index", "-z", "--stdin"],
        cwd=cwd,
        input=paths,
        capture_output=True,
        check=False,
    )
    if ignored.returncode not in (0, 1):
        raise SystemExit("Unable to evaluate document ignore rules.")
    return set(ignored.stdout.split(b"\0"))


def document_excludes(paths):
    rules = Path(".docsignore")
    if rules.is_symlink():
        raise SystemExit(".docsignore must not be a symlink.")
    try:
        content = rules.read_bytes()
    except FileNotFoundError:
        return set()

    # Match root-relative Git patterns in isolation: repository .gitignore
    # negations must never expose a document excluded by .docsignore.
    with TemporaryDirectory() as worktree:
        subprocess.run(["git", "init", "-q", "--template="], cwd=worktree, check=True)
        (Path(worktree) / ".gitignore").write_bytes(content)
        return ignored_paths(paths, cwd=worktree)


def collect_documents():
    paths = subprocess.check_output(["git", "ls-files", "-z", "--", "docs/"])
    excluded = ignored_paths(paths) | document_excludes(paths)
    files = []
    for raw_path in paths.split(b"\0"):
        if not raw_path or raw_path in excluded:
            continue
        path = Path(os.fsdecode(raw_path))
        if path.suffix not in FORMATS:
            continue
        relative = path.relative_to("docs").as_posix()
        if len(relative) > 240 or not DOCUMENT_PATH.fullmatch(relative):
            raise SystemExit(f"Unsupported document path: {str(path)!r}. Use lowercase letters, digits, '_' or '-'.")
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents) or not path.is_file():
            raise SystemExit("Documents must be regular files, not symlinks.")
        if path.stat().st_size > 480_000 or len(files) >= 250:
            raise SystemExit("Document limit exceeded.")
        content = path.read_text(encoding="utf-8")
        if len(content.encode("utf-16-le")) // 2 > 120_000:
            raise SystemExit(f"Document exceeds 120,000 UTF-16 code units: {path}")
        files.append({"path": relative, "content": content})
    payload = json.dumps({"files": files}, ensure_ascii=False).encode("utf-8")
    if not files or len(payload) > 2 * 1024 * 1024:
        raise SystemExit("Publish 1–250 documents and at most 2 MiB of JSON.")
    return payload


def publish(endpoint, payload):
    token_url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL")
    token_request = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not token_url or not token_request:
        raise SystemExit("This job needs GitHub Actions permission: id-token: write.")

    opener = build_opener(NoRedirect)
    separator = "&" if urlsplit(token_url).query else "?"
    request = Request(
        token_url + separator + urlencode({"audience": endpoint}),
        headers={"Authorization": "Bearer " + token_request},
    )
    try:
        with opener.open(request, timeout=15) as response:
            assertion = json.load(response)["value"]
        request = Request(
            endpoint,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + assertion},
        )
        with opener.open(request, timeout=60) as response:
            result = json.load(response)
            url = result.get("url") or f"/docs/{result['collection']}"
            print(f"Published {result['count']} documents to {url}")
            if result.get("llmsTxt"):
                print(f"Documentation index: {result['llmsTxt']}")
    except HTTPError as error:
        if error.url == endpoint:
            try:
                message = json.loads(error.read(4096))["error"]
                print("Portal response: " + json.dumps(str(message)[:500], ensure_ascii=True))
            except (ValueError, KeyError, TypeError):
                pass
        raise SystemExit(f"Publish request failed: HTTP {error.code}") from None
    except (URLError, TimeoutError, ValueError, KeyError, TypeError):
        raise SystemExit("Could not contact GitHub OIDC or the portal, or the response was invalid.") from None


if __name__ == "__main__":
    publish(publish_endpoint(os.environ["PORTAL_ORIGIN"]), collect_documents())
