from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auto_pid_tuning.styles import STYLES
from auto_pid_tuning.web import app
from conftest import SAMPLES

client = TestClient(app)

SAMPLE_4_3 = SAMPLES / "gg_LOG00001.BFL"
SAMPLE_MULTI = SAMPLES / "gg_btfl_001.bbl"
needs_sample = pytest.mark.skipif(not SAMPLE_4_3.is_file(), reason="sample logs not downloaded")


def test_index_and_static_files():
    page = client.get("/")
    assert page.status_code == 200
    assert "Betaflight auto-tune" in page.text
    for name in ("app.js", "chart.js", "style.css"):
        assert client.get(f"/static/{name}").status_code == 200


def test_version():
    version = client.get("/api/version").json()["version"]
    assert version == app.version


def test_styles():
    styles = client.get("/api/styles").json()
    assert [style["name"] for style in styles] == list(STYLES)
    assert all(style["description"] for style in styles)


def test_garbage_upload_is_rejected():
    response = client.post("/api/analyze", files={"file": ("notes.txt", b"not a blackbox log")})
    assert response.status_code == 400
    assert response.json()["detail"]


def test_missing_file_is_rejected():
    assert client.post("/api/analyze").status_code == 422


@needs_sample
def test_analyze_real_log():
    with SAMPLE_4_3.open("rb") as handle:
        response = client.post("/api/analyze", files={"file": (SAMPLE_4_3.name, handle)})
    assert response.status_code == 200
    payload = response.json()

    assert payload["filename"] == SAMPLE_4_3.name
    assert payload["log_count"] == payload["log_index"] == 1
    assert payload["firmware"].startswith("Betaflight 4.3.0")
    assert set(payload["tunes"]) == set(STYLES)
    assert payload["tunes"]["cinematic"]["cli"][-1] == "save"
    assert payload["tunes"]["cinematic"]["peak_max"] == STYLES["cinematic"].peak_max
    # Every chart a change points to is in the payload.
    for tune in payload["tunes"].values():
        charts = set(payload["excerpts"]) | set(tune["evidence"])
        assert {change["evidence"] for change in tune["changes"]} <= charts | {None}
    assert len(payload["spectrum"]["hz"]) == len(payload["spectrum"]["roll"]) > 10
    assert payload["axes"]["yaw"]["step_response"]["valid"] is True


@needs_sample
def test_analyze_picks_a_flight():
    def post(index):
        with SAMPLE_MULTI.open("rb") as handle:
            return client.post(
                "/api/analyze",
                files={"file": (SAMPLE_MULTI.name, handle)},
                data={} if index is None else {"log_index": str(index)},
            )

    default = post(None).json()
    assert default["log_count"] == 3
    assert default["log_index"] == 3  # the longest flight unless asked otherwise

    assert post(1).json()["log_index"] == 1
    assert post(7).status_code == 400
