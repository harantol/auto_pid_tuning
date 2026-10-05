"""FastAPI application: one page and one endpoint on top of the tuning core."""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
import threading
import webbrowser
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ..analysis import analyze
from ..blackbox import LogError, flight_sizes, load_log
from ..report import flight_to_dict, tuning_to_dict
from ..styles import STYLES
from ..tuner import tune

STATIC = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 128 * 1024 * 1024

app = FastAPI(title="Betaflight auto-tuning")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/styles")
def styles() -> list[dict]:
    return [{"name": style.name, "description": style.description} for style in STYLES.values()]


# A plain `def`: decoding a log takes seconds of CPU, so FastAPI runs it in a worker thread.
@app.post("/api/analyze")
def analyze_upload(file: UploadFile, log_index: int | None = Form(None)) -> dict:
    """Analyse one flight of an uploaded log and tune it for every style.

    Tuning is cheap next to decoding, so all styles are returned at once and the page
    switches between them without another upload.
    """
    if file.size is not None and file.size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Log file is larger than 128 MB.")

    # The decoder reads from a path, so the upload goes through a temporary file.
    suffix = Path(file.filename or "log.bbl").suffix
    handle, name = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(handle, "wb") as out:
            shutil.copyfileobj(file.file, out)
        try:
            sizes = flight_sizes(name)
            count = len(sizes)
            index = log_index or sizes.index(max(sizes)) + 1  # the longest flight by default
            if not 1 <= index <= count:
                raise LogError(f"This file holds {count} flight(s); flight {index} does not exist.")
            log = load_log(name, index)
        except LogError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # the decoder raises bare exceptions on files that are not logs
            raise HTTPException(400, f"Not a readable blackbox log: {exc}") from exc
    finally:
        os.unlink(name)

    analysis = analyze(log)
    return {
        "filename": file.filename,
        "log_index": index,
        "log_count": count,
        "flight_bytes": sizes,
        **flight_to_dict(log.headers, analysis),
        "tunes": {
            style.name: tuning_to_dict(tune(log.headers, analysis, style))
            for style in STYLES.values()
        },
    }


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    parser = argparse.ArgumentParser(
        prog="auto-pid-tuning-web", description="Serve the Betaflight auto-tuning web app."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    args = parser.parse_args(argv)

    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [f"http://{args.host}:{args.port}"]).start()
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
