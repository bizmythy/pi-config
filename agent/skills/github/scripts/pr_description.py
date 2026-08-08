# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "click>=8.1,<9",
#   "websocket-client>=1.8,<2",
# ]
# ///
"""Create or update a GitHub pull request with reliably embedded media."""

from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import click
import websocket

IMAGE_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".svg"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".webm"}
ATTACHMENT_URL_RE = re.compile(r"https://github\.com/user-attachments/(?:assets|files)/[^\s)]+")
ASSETS_RELEASE_TAG = "_pi-pr-description-assets"


@dataclass(frozen=True)
class MediaSpec:
    marker: str
    path: Path
    kind: str


def fail(message: str) -> click.ClickException:
    return click.ClickException(message)


def run(command: Sequence[str], *, env: dict[str, str] | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            text=True,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as error:
        raise fail(f"required command not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()
        suffix = f": {detail}" if detail else ""
        raise fail(f"command failed ({error.returncode}): {' '.join(command)}{suffix}") from error
    return result.stdout.strip()


def parse_media(value: str, kind: str) -> MediaSpec:
    marker, separator, filename = value.partition("=")
    if not separator or not marker.strip() or not filename.strip():
        raise fail(f"--{kind} must be MARKER=FILE (for example, '{{{{demo}}}}=demo.mp4')")

    path = Path(filename).expanduser().resolve()
    if not path.is_file():
        raise fail(f"{kind} file does not exist: {path}")

    extension = path.suffix.lower()
    allowed = IMAGE_EXTENSIONS if kind == "image" else VIDEO_EXTENSIONS
    if extension not in allowed:
        supported = ", ".join(sorted(allowed))
        raise fail(f"unsupported {kind} extension {extension or '(none)'}; expected one of: {supported}")

    size = path.stat().st_size
    maximum = 10 * 1024 * 1024 if kind == "image" else 100 * 1024 * 1024
    if size > maximum:
        raise fail(f"{path.name} exceeds GitHub's {maximum // (1024 * 1024)} MB {kind} limit")

    return MediaSpec(marker.strip(), path, kind)


def option_value(arguments: Sequence[str], long: str, short: str) -> str | None:
    value: str | None = None
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument in {long, short}:
            if index + 1 >= len(arguments):
                raise fail(f"{argument} requires a value")
            value = arguments[index + 1]
            index += 2
            continue
        if argument.startswith(f"{long}="):
            value = argument.split("=", 1)[1]
        elif argument.startswith(short) and argument != short and len(short) == 2:
            value = argument[len(short) :].removeprefix("=")
        index += 1
    return value


def reject_body_text(arguments: Sequence[str]) -> None:
    for argument in arguments:
        if argument in {"--body", "-b"} or argument.startswith(("--body=", "-b")):
            raise fail("direct body text is not supported; use --body-file/-F")


def resolve_repo(arguments: Sequence[str], pr: str | None = None) -> str:
    repo = option_value(arguments, "--repo", "-R")
    if repo is None and pr:
        match = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/\d+/?$", pr)
        if match:
            repo = match.group(1)
    if repo is None:
        repo = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])

    parts = repo.removeprefix("https://github.com/").rstrip("/").split("/")
    if len(parts) > 2 and "." in parts[-3]:
        parts = parts[-2:]
    if len(parts) != 2 or not all(parts):
        raise fail(f"could not interpret repository as OWNER/REPO: {repo}")
    return "/".join(parts)


def validate_marker(body: str, media: MediaSpec) -> None:
    count = body.count(media.marker)
    if count != 1:
        raise fail(f"marker {media.marker!r} must occur exactly once in the PR body (found {count})")
    if media.kind == "video" and not re.search(rf"(?m)^[ \t]*{re.escape(media.marker)}[ \t]*$", body):
        raise fail(f"video marker {media.marker!r} must be alone on its line so GitHub renders a player")


def replace_marker(body: str, media: MediaSpec, href: str) -> str:
    if media.kind == "video":
        line_pattern = re.compile(rf"(?m)^[ \t]*{re.escape(media.marker)}[ \t]*$")
        return line_pattern.sub(f"\n{href}\n", body, count=1)

    alt = media.path.name.replace("\\", "\\\\").replace("]", "\\]")
    return body.replace(media.marker, f"![{alt}]({href})", 1)


def gh_image_command() -> list[str]:
    try:
        check = subprocess.run(
            ["gh", "image", "--version"],
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError as error:
        raise fail("required command not found: gh") from error
    if check.returncode == 0:
        return ["gh", "image"]

    system = platform.system().lower()
    machine = platform.machine().lower()
    architecture = {
        "x86_64": "amd64",
        "amd64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(machine)
    os_name = {"darwin": "darwin", "linux": "linux", "windows": "windows"}.get(system)
    if not os_name or not architecture:
        raise fail(f"gh-image has no prebuilt binary for {system}/{machine}")

    suffix = ".exe" if os_name == "windows" else ""
    asset = f"{os_name}-{architecture}{suffix}"
    tag = run(
        [
            "gh",
            "release",
            "view",
            "--repo",
            "drogers0/gh-image",
            "--json",
            "tagName",
            "--jq",
            ".tagName",
        ]
    )
    cache_root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    binary = cache_root / "pi" / "gh-image" / tag / asset
    if not binary.is_file():
        click.echo(f"Downloading drogers0/gh-image {tag}...", err=True)
        binary.parent.mkdir(parents=True, exist_ok=True)
        run(
            [
                "gh",
                "release",
                "download",
                tag,
                "--repo",
                "drogers0/gh-image",
                "--pattern",
                asset,
                "--output",
                str(binary),
                "--clobber",
            ]
        )
        binary.chmod(0o755)
    run([str(binary), "--version"])
    return [str(binary)]


def cdp_session_token() -> str | None:
    """Read the active GitHub web session from a running CDP-enabled Chromium."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=2) as response:
            websocket_url = json.load(response)["webSocketDebuggerUrl"]
        connection = websocket.create_connection(
            websocket_url,
            timeout=5,
            suppress_origin=True,
        )
        try:
            connection.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
            while True:
                message = json.loads(connection.recv())
                if message.get("id") == 1:
                    break
        finally:
            connection.close()
    except Exception:
        return None

    cookies = message.get("result", {}).get("cookies", [])
    for cookie in cookies:
        if (
            cookie.get("name") == "user_session"
            and cookie.get("value")
            and cookie.get("domain", "").lstrip(".") == "github.com"
        ):
            return str(cookie["value"])
    return None


def ensure_assets_release(repo: str) -> None:
    exists = subprocess.run(
        ["gh", "release", "view", ASSETS_RELEASE_TAG, "--repo", repo],
        text=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if exists.returncode == 0:
        return

    run(
        [
            "gh",
            "release",
            "create",
            ASSETS_RELEASE_TAG,
            "--repo",
            repo,
            "--title",
            "PR description assets",
            "--notes",
            "Assets embedded in pull request descriptions. Do not delete this release or its assets.",
            "--prerelease",
        ]
    )


def upload_release_asset(repo: str, media: MediaSpec) -> str:
    """Token-authenticated fallback using GitHub's supported release API."""
    ensure_assets_release(repo)
    asset_name = f"{uuid.uuid4()}-{media.path.name}"
    with tempfile.TemporaryDirectory() as directory:
        upload_path = Path(directory) / asset_name
        shutil.copyfile(media.path, upload_path)
        run(
            [
                "gh",
                "release",
                "upload",
                ASSETS_RELEASE_TAG,
                str(upload_path),
                "--repo",
                repo,
            ]
        )
    encoded_name = urllib.parse.quote(asset_name)
    return f"https://github.com/{repo}/releases/download/{ASSETS_RELEASE_TAG}/{encoded_name}"


def upload_media(command: Sequence[str] | None, repo: str, media: MediaSpec) -> str:
    if command is None:
        return upload_release_asset(repo, media)

    env = os.environ.copy()
    if not env.get("GH_SESSION_TOKEN"):
        token = cdp_session_token()
        if token:
            env["GH_SESSION_TOKEN"] = token
    try:
        output = run([*command, "--repo", repo, str(media.path)], env=env)
    except click.ClickException:
        click.echo(
            "User-attachment upload unavailable; using a release asset via active gh authentication.",
            err=True,
        )
        return upload_release_asset(repo, media)

    match = ATTACHMENT_URL_RE.search(output)
    if not match:
        raise fail(f"gh image returned no GitHub user-attachment URL for {media.path.name}: {output!r}")
    return match.group(0)


@click.command(
    context_settings={
        "allow_extra_args": True,
        "ignore_unknown_options": True,
        "help_option_names": ["-h", "--help"],
        "max_content_width": 100,
    }
)
@click.option(
    "-F",
    "--body-file",
    "body_file",
    required=True,
    type=click.Path(exists=True, dir_okay=False, readable=True, path_type=Path),
    help="Markdown file containing the PR description and media markers.",
)
@click.option(
    "--pr",
    metavar="NUMBER_OR_URL",
    help="Update this existing PR instead of creating one.",
)
@click.option(
    "--image",
    "images",
    multiple=True,
    metavar="MARKER=FILE",
    help="Upload an image and replace MARKER with GitHub's inline-image Markdown. Repeatable.",
)
@click.option(
    "--video",
    "videos",
    multiple=True,
    metavar="MARKER=FILE",
    help="Upload a video and replace a line containing only MARKER with an inline player. Repeatable.",
)
@click.argument("gh_arguments", nargs=-1, type=click.UNPROCESSED)
def main(
    body_file: Path,
    pr: str | None,
    images: Iterable[str],
    videos: Iterable[str],
    gh_arguments: tuple[str, ...],
) -> None:
    """Create or update a PR description, reliably embedding local images and videos.

    Write the description in --body-file and put a unique marker on its own line for each media
    file. Map markers with repeatable --image and --video options. Other arguments pass through
    to `gh pr create`, or to `gh pr edit` when --pr is supplied. Direct --body/-b text is rejected.

    \b
    Create:
      uv run pr_description.py -F /tmp/pr.md \\
        --image '{{before}}=before.png' --video '{{demo}}=demo.mp4' \\
        --title 'Improve preview' --base main

    \b
    Update PR 123:
      uv run pr_description.py --pr 123 -F /tmp/pr.md \\
        --image '{{after}}=after.png' --repo owner/repo

    Images use Markdown image embeds. Videos use bare user-attachment URLs on their own lines,
    which GitHub renders as players. The script first uses drogers0/gh-image's user-attachment
    flow. If no GitHub web session is available, it automatically falls back to the repository's
    `_pi-pr-description-assets` prerelease, uploaded through the active `gh` credential. GitHub
    renders bare release video URLs as inline players. The installed `gh image` extension is used
    when available; otherwise its release binary is downloaded to the user cache.

    Supported images: PNG, GIF, JPEG, and SVG (10 MB maximum). Supported videos: MP4, MOV, and
    WEBM (100 MB maximum; free-plan repositories may impose 10 MB). H.264 is the most compatible
    video codec. The `gh` CLI must be installed and authenticated. Supplying --repo is recommended
    outside the target checkout.
    """
    media = [
        *(parse_media(value, "image") for value in images),
        *(parse_media(value, "video") for value in videos),
    ]
    markers = [item.marker for item in media]
    if len(markers) != len(set(markers)):
        raise fail("each media marker must be unique")

    reject_body_text(gh_arguments)
    body = body_file.read_text(encoding="utf-8")
    for item in media:
        validate_marker(body, item)

    if media:
        repo = resolve_repo(gh_arguments, pr)
        try:
            image_command = gh_image_command()
        except click.ClickException:
            image_command = None
            click.echo(
                "gh-image unavailable; using release assets via active gh authentication.",
                err=True,
            )
        for item in media:
            click.echo(f"Uploading {item.path.name}...", err=True)
            href = upload_media(image_command, repo, item)
            body = replace_marker(body, item, href)

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md") as rendered_body_file:
        rendered_body_file.write(body)
        rendered_body_file.flush()
        command = ["gh", "pr", "edit" if pr else "create"]
        if pr:
            command.append(pr)
        command.extend([*gh_arguments, "--body-file", rendered_body_file.name])
        completed = subprocess.run(command)
    if completed.returncode:
        raise click.exceptions.Exit(completed.returncode)


if __name__ == "__main__":
    main()
