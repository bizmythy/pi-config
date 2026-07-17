# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "browser-cookie3>=0.20,<1",
#   "click>=8.1,<9",
#   "requests>=2.32,<3",
# ]
# ///
"""Create or update a GitHub pull request with reliably embedded media."""

from __future__ import annotations

import mimetypes
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

import click
import requests

GITHUB = "https://github.com"
USER_AGENT = "pi-github-create-pr-with-media/1.0"
UPLOAD_TOKEN_RE = re.compile(r'"uploadToken":"([^"]+)"')
IMAGE_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".svg"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".webm"}
CONTENT_TYPES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
}


@dataclass(frozen=True)
class MediaSpec:
    marker: str
    path: Path
    kind: str


def fail(message: str) -> click.ClickException:
    return click.ClickException(message)


def run(command: Sequence[str], *, stdin: str | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            input=stdin,
            text=True,
            check=True,
            stdout=subprocess.PIPE,
        )
    except FileNotFoundError as error:
        raise fail(f"required command not found: {command[0]}") from error
    except subprocess.CalledProcessError as error:
        raise fail(f"command failed ({error.returncode}): {' '.join(command)}") from error
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
        if argument == long or argument == short:
            if index + 1 >= len(arguments):
                raise fail(f"{argument} requires a value")
            value = arguments[index + 1]
            index += 2
            continue
        if argument.startswith(f"{long}="):
            value = argument.split("=", 1)[1]
        elif argument.startswith(short) and argument != short and len(short) == 2:
            value = argument[len(short) :]
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


def session_candidates() -> list[str]:
    explicit = os.environ.get("GH_SESSION_TOKEN")
    if explicit:
        return [explicit.strip()]

    try:
        import browser_cookie3

        cookies = browser_cookie3.load(domain_name="github.com")
    except Exception as error:
        raise fail(
            "could not read GitHub browser cookies; log in to github.com in a supported "
            "browser or set GH_SESSION_TOKEN"
        ) from error

    candidates: list[str] = []
    for cookie in cookies:
        if cookie.name == "user_session" and cookie.value not in candidates:
            candidates.append(cookie.value)
    if not candidates:
        raise fail(
            "no github.com user_session cookie found; log in in a supported browser or "
            "set GH_SESSION_TOKEN"
        )
    return candidates


def authenticated_session(session_token: str) -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    session.cookies.set("user_session", session_token, domain="github.com", path="/")
    # GitHub's CSRF check requires this host-only twin of user_session.
    session.cookies.set("__Host-user_session_same_site", session_token, path="/")
    return session


def find_upload_session(repo: str) -> tuple[requests.Session, str]:
    owner = repo.split("/", 1)[0]
    for token in session_candidates():
        session = authenticated_session(token)
        response = session.get(f"{GITHUB}/{repo}", timeout=30)
        match = UPLOAD_TOKEN_RE.search(response.text) if response.ok else None
        if match:
            return session, match.group(1)
        if response.ok and re.search(rf"/orgs/{re.escape(owner)}/sso\b", response.text, re.I):
            raise fail(
                f"{owner} requires SAML SSO authorization; visit "
                f"https://github.com/orgs/{owner}/sso in the same browser, then retry"
            )
    raise fail(f"no browser session with write access to {repo} supplied an upload token")


def checked_response(response: requests.Response, expected: int, step: str) -> requests.Response:
    if response.status_code != expected:
        excerpt = response.text.replace("\n", " ")[:300]
        raise fail(f"{step} failed: expected HTTP {expected}, got {response.status_code}: {excerpt}")
    return response


def upload_media(
    session: requests.Session,
    upload_token: str,
    repo: str,
    repository_id: int,
    media: MediaSpec,
) -> str:
    content_type = CONTENT_TYPES.get(media.path.suffix.lower())
    if content_type is None:
        guessed, _ = mimetypes.guess_type(media.path.name)
        content_type = guessed or "application/octet-stream"

    headers = {
        "Accept": "application/json",
        "Origin": GITHUB,
        "Referer": f"{GITHUB}/{repo}",
        "X-Requested-With": "XMLHttpRequest",
    }
    policy_response = session.post(
        f"{GITHUB}/upload/policies/assets",
        data={
            "name": media.path.name,
            "size": str(media.path.stat().st_size),
            "content_type": content_type,
            "authenticity_token": upload_token,
            "repository_id": str(repository_id),
        },
        headers=headers,
        timeout=30,
    )
    policy = checked_response(policy_response, 201, f"requesting upload policy for {media.path.name}").json()

    with media.path.open("rb") as file:
        s3_response = requests.post(
            policy["upload_url"],
            data=policy["form"],
            files={"file": (media.path.name, file, content_type)},
            headers={"Origin": GITHUB},
            timeout=120,
        )
    checked_response(s3_response, 204, f"uploading {media.path.name} to storage")

    finalize_response = session.put(
        f"{GITHUB}{policy['asset_upload_url']}",
        data={"authenticity_token": policy["asset_upload_authenticity_token"]},
        headers=headers,
        timeout=30,
    )
    result = checked_response(finalize_response, 200, f"finalizing {media.path.name}").json()
    href = result.get("href")
    if not isinstance(href, str) or not href.startswith(f"{GITHUB}/user-attachments/"):
        raise fail(f"GitHub returned an invalid attachment URL for {media.path.name}: {href!r}")
    return href


def replace_marker(body: str, media: MediaSpec, href: str) -> str:
    count = body.count(media.marker)
    if count != 1:
        raise fail(f"marker {media.marker!r} must occur exactly once in the PR body (found {count})")

    if media.kind == "video":
        line_pattern = re.compile(rf"(?m)^[ \t]*{re.escape(media.marker)}[ \t]*$")
        if not line_pattern.search(body):
            raise fail(
                f"video marker {media.marker!r} must be alone on its line so GitHub renders a player"
            )
        return line_pattern.sub(f"\n{href}\n", body, count=1)

    alt = media.path.name.replace("\\", "\\\\").replace("]", "\\]")
    return body.replace(media.marker, f"![{alt}]({href})", 1)


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

    Image markers become Markdown image embeds. Video markers become bare user-attachment URLs
    on their own lines, which GitHub renders as video players. Supported images: PNG, GIF, JPEG,
    and SVG (10 MB maximum). Supported videos: MP4, MOV, and WEBM (100 MB maximum; free-plan
    repositories may impose 10 MB). H.264 video is the most browser-compatible.

    Uploads use the logged-in GitHub session from a local browser and require repository write
    access. Set GH_SESSION_TOKEN only when browser cookies are unavailable. The `gh` CLI must also
    be installed and authenticated. Supplying --repo is recommended outside the target checkout.
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
    if media:
        repo = resolve_repo(gh_arguments, pr)
        repository_id_text = run(["gh", "api", f"repos/{repo}", "--jq", ".id"])
        try:
            repository_id = int(repository_id_text)
        except ValueError as error:
            raise fail(f"GitHub returned an invalid repository id: {repository_id_text!r}") from error

        session, upload_token = find_upload_session(repo)
        for item in media:
            click.echo(f"Uploading {item.path.name}...", err=True)
            href = upload_media(session, upload_token, repo, repository_id, item)
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
