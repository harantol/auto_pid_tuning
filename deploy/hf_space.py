"""Point the Hugging Face Space at one image version.

The Space only holds a Dockerfile that starts from the image CI pushed to GHCR, so the
online app runs exactly what S13 runs. Anything else in the Space (such as the template
files Hugging Face adds on creation) is removed in the same commit. Needs HF_TOKEN (write)
in the environment.

    uv run --no-project --with huggingface_hub python deploy/hf_space.py <space> <image>
"""

from __future__ import annotations

import sys

from huggingface_hub import CommitOperationAdd, CommitOperationDelete, HfApi

README = """---
title: Betaflight auto-tune
emoji: 🚁
colorFrom: blue
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

Betaflight PID, filter and rate tuning from a blackbox log.
Source: https://github.com/harantol/auto_pid_tuning
"""

KEEP = {".gitattributes"}  # git settings of the Space repository, not content


def main(space: str, image: str) -> None:
    api = HfApi()
    api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
    files = {"README.md": README, "Dockerfile": f"FROM {image}\n"}
    stale = set(api.list_repo_files(space, repo_type="space")) - set(files) - KEEP
    api.create_commit(
        repo_id=space,
        repo_type="space",
        operations=[
            *(
                CommitOperationAdd(path_in_repo=path, path_or_fileobj=text.encode())
                for path, text in files.items()
            ),
            *(CommitOperationDelete(path_in_repo=path) for path in sorted(stale)),
        ],
        commit_message=f"Deploy {image}",
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
