import json
import math
import os
from glob import glob
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, Response, jsonify, redirect, request, send_from_directory

BASE_DIR = Path(__file__).parent.parent  # project root (tools/ is one level down)
DATA_DIR = BASE_DIR / "data"
VIDEOS_DIR = DATA_DIR / "videos"
VIEWER_DIR = BASE_DIR / "tools" / "viewer"

app = Flask(__name__)


class SafeEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return None if math.isnan(obj) else float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        if isinstance(obj, float) and math.isnan(obj):
            return None
        return super().default(obj)


def safe_jsonify(data):
    return app.response_class(
        json.dumps(data, cls=SafeEncoder),
        mimetype="application/json",
    )


def clean(obj):
    """Recursively convert numpy scalars and NaN to JSON-safe Python types."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, np.ndarray)):
        return [clean(v) for v in obj]
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return None if math.isnan(obj) else float(obj)
    if isinstance(obj, float) and math.isnan(obj):
        return None
    return obj


# ── Static file serving ────────────────────────────────────────────────────────

@app.route("/")
def root():
    return redirect("/viewer/")


@app.route("/viewer/")
def viewer_index():
    return send_from_directory(VIEWER_DIR, "index.html")


@app.route("/viewer/<path:filename>")
def viewer_static(filename):
    return send_from_directory(VIEWER_DIR, filename)


CHUNK = 2 * 1024 * 1024  # 2 MB per chunk

@app.route("/data/videos/<path:filename>")
def serve_video(filename):
    path = (VIDEOS_DIR / filename).resolve()
    if not path.exists() or not str(path).startswith(str(VIDEOS_DIR.resolve())):
        return "", 404

    file_size = path.stat().st_size
    mime_map = {".mp4": "video/mp4", ".webm": "video/webm",
                ".mkv": "video/x-matroska", ".avi": "video/x-msvideo"}
    mime = mime_map.get(path.suffix.lower(), "application/octet-stream")

    range_header = request.headers.get("Range")
    if range_header:
        byte_range = range_header.replace("bytes=", "").strip()
        start_str, _, end_str = byte_range.partition("-")
        start = int(start_str) if start_str else 0
        end   = min(int(end_str), file_size - 1) if end_str else min(start + CHUNK - 1, file_size - 1)
        length = end - start + 1

        def generate():
            remaining = length
            with path.open("rb") as f:
                f.seek(start)
                while remaining > 0:
                    data = f.read(min(CHUNK, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        resp = Response(generate(), status=206, mimetype=mime)
        resp.headers["Content-Range"]  = f"bytes {start}-{end}/{file_size}"
        resp.headers["Accept-Ranges"]  = "bytes"
        resp.headers["Content-Length"] = length
        return resp

    # No Range header: stream the whole file in chunks
    def stream_file():
        with path.open("rb") as f:
            while True:
                data = f.read(CHUNK)
                if not data:
                    break
                yield data

    resp = Response(stream_file(), status=200, mimetype=mime)
    resp.headers["Accept-Ranges"]  = "bytes"
    resp.headers["Content-Length"] = file_size
    return resp


# ── API ────────────────────────────────────────────────────────────────────────

@app.route("/api/parquet-files")
def api_parquet_files():
    files = sorted(DATA_DIR.glob("*.parquet"))
    return jsonify([f.name for f in files])


@app.route("/api/videos")
def api_videos():
    file = request.args.get("file", "")
    if not file or "/" in file or not file.endswith(".parquet"):
        return jsonify({"error": "invalid file"}), 400
    path = DATA_DIR / file
    if not path.exists():
        return jsonify({"error": "not found"}), 404

    df = pd.read_parquet(path, columns=["video_uid", "metadata"])
    result = []
    for _, row in df.iterrows():
        meta = row["metadata"] if isinstance(row["metadata"], dict) else {}
        result.append({
            "uid": row["video_uid"],
            "title": meta.get("title") or row["video_uid"],
            "duration": clean(meta.get("duration", 0)),
        })
    return jsonify(result)


@app.route("/api/video")
def api_video():
    file = request.args.get("file", "")
    uid = request.args.get("uid", "")
    if not file or "/" in file or not file.endswith(".parquet"):
        return jsonify({"error": "invalid file"}), 400
    path = DATA_DIR / file
    if not path.exists():
        return jsonify({"error": "not found"}), 404

    df = pd.read_parquet(path)
    rows = df[df["video_uid"] == uid]
    if rows.empty:
        return jsonify({"error": "video not found"}), 404

    row = rows.iloc[0]
    meta = clean(row["metadata"]) if isinstance(row["metadata"], dict) else {}
    nodes = clean(row["nodes"]) if row["nodes"] is not None else []

    return safe_jsonify({"video_uid": uid, "metadata": meta, "nodes": nodes})


@app.route("/api/has-video")
def api_has_video():
    uid = request.args.get("uid", "")
    file = request.args.get("file", "")
    if not uid or not file:
        return jsonify({"exists": False, "path": ""})

    stem = Path(file).stem
    folder = VIDEOS_DIR / stem
    if not folder.exists():
        return jsonify({"exists": False, "path": ""})

    matches = list(folder.glob(f"{uid}.*"))
    # filter out audio-only formats (.m4a, .webm without video track marker)
    playable = [m for m in matches if m.suffix in (".mp4", ".webm", ".mkv", ".avi")]
    mp4 = [m for m in playable if m.suffix == ".mp4"]
    chosen = mp4[0] if mp4 else (playable[0] if playable else None)
    if chosen:
        # path relative to project root for URL construction
        rel = chosen.relative_to(BASE_DIR)
        return jsonify({"exists": True, "path": str(rel)})
    return jsonify({"exists": False, "path": ""})


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Action100M Viewer → http://localhost:8765/viewer/")
    app.run(host="0.0.0.0", port=8765, debug=False)
