"""Point the Hugging Face Space at one image version.

The Space only holds a Dockerfile that starts from the image CI pushed to GHCR, so the
online app runs exactly what S13 runs. Needs HF_TOKEN (write) in the environment.

    uv run --no-project --with huggingface_hub python deploy/hf_space.py <space> <image>
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

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


def main(space: str, image: str) -> None:
    api = HfApi()
    api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        Path(folder, "README.md").write_text(README, encoding="utf-8")
        Path(folder, "Dockerfile").write_text(f"FROM {image}\n", encoding="utf-8")
        api.upload_folder(
            repo_id=space, repo_type="space", folder_path=folder, commit_message=f"Deploy {image}"
        )


if __name__ == "__main__":
    main(*sys.argv[1:])
