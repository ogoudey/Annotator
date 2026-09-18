"""Auto-annotation: cut the selected range out of the video and hand it to
`gemini.annotate` for labelling.

    gemini.annotate(clip_paths, layer_ids_to_annotate,
                    layer_instructions, layer_to_use_annotation_in_prompt_from)

`clip_paths` is a list, one entry per camera view the user ticked, all cut from
the same global range so they stay aligned. `gemini` is imported inside the job
rather than at module scope, so the rest of the app still runs if it is not
installed and the failure lands in the job's error instead of at startup.

Whatever comes back is put through `normalize_result`, which accepts:

    {"ly_1": "text"}                                  one clip over the range
    {"ly_1": [{"start": 0.0, "end": 2.5, "text": …}]} sub-segments, relative
                                                       to the start of the slice
    [{"layer_id": "ly_1", "start": …, "end": …, "text": …}]

Times coming back are treated as relative to the slice (it starts at 0), which
is the only thing a model looking at the cut video can reasonably report.

Slicing crosses file boundaries: a selection can span two mp4s of one view,
since v3 splits each video key independently by size. Parts are cut,
re-encoded to H.264 and concatenated. Each view is cut separately, which is
what keeps them aligned when their boundaries fall in different places.
"""

from __future__ import annotations

import inspect
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

MAX_WIDTH = 1280           # keep uploads small; -2 keeps the aspect ratio
JOB_TTL_SECONDS = 3600


class AutoAnnotateError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------

@dataclass
class Job:
    id: str
    state: str = "queued"          # queued | running | done | error
    step: str = "queued"
    progress: float = 0.0          # 0..1, or -1 for "indeterminate"
    error: str | None = None
    result: list[dict[str, Any]] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    created: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "state": self.state, "step": self.step,
            "progress": self.progress, "error": self.error,
            "result": self.result, "log": self.log[-8:],
        }


_JOBS: dict[str, Job] = {}
_LOCK = threading.Lock()


def create_job() -> Job:
    with _LOCK:
        for job_id, job in list(_JOBS.items()):   # opportunistic cleanup
            if time.time() - job.created > JOB_TTL_SECONDS:
                _JOBS.pop(job_id, None)
        job = Job(id=uuid.uuid4().hex[:12])
        _JOBS[job.id] = job
        return job


def get_job(job_id: str) -> Job | None:
    with _LOCK:
        return _JOBS.get(job_id)


def _set(job: Job, step: str, progress: float, note: str | None = None) -> None:
    job.step = step
    job.progress = progress
    if note:
        job.log.append(note)


# --------------------------------------------------------------------------
# slicing
# --------------------------------------------------------------------------

def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-3:]
        raise AutoAnnotateError("ffmpeg failed: " + " / ".join(tail))


def slice_range(
    root: Path,
    segments: list[dict[str, Any]],
    start: float,
    end: float,
    out_dir: Path,
    accurate: bool = True,
) -> Path:
    """Cut global [start, end) out of one view, across file boundaries."""
    overlapping = [s for s in segments if s["end"] > start and s["start"] < end]
    if not overlapping:
        raise AutoAnnotateError(f"No video covers {start:.2f}s - {end:.2f}s for this view.")

    parts: list[Path] = []
    for i, seg in enumerate(overlapping):
        local_start = max(0.0, start - seg["start"])
        local_end = min(seg["end"], end) - seg["start"]
        if local_end - local_start < 1e-3:
            continue
        part = out_dir / f"part-{i:02d}.mp4"
        source = root / seg["path"]
        if accurate:
            # -ss after -i is frame-accurate; re-encoding also normalises the
            # codec, which matters because these are often AV1.
            cmd = [
                "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                "-i", str(source), "-ss", f"{local_start:.3f}", "-to", f"{local_end:.3f}",
                "-an", "-vf", f"scale='min({MAX_WIDTH},iw)':-2",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                "-movflags", "+faststart", str(part),
            ]
        else:
            cmd = [
                "ffmpeg", "-nostdin", "-loglevel", "error", "-y",
                "-ss", f"{local_start:.3f}", "-i", str(source),
                "-t", f"{local_end - local_start:.3f}", "-an", "-c", "copy", str(part),
            ]
        _run(cmd)
        parts.append(part)

    if not parts:
        raise AutoAnnotateError("The selected range produced no video.")
    if len(parts) == 1:
        return parts[0]

    listing = out_dir / "parts.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts))
    joined = out_dir / "slice.mp4"
    _run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
          "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(joined)])
    return joined


# --------------------------------------------------------------------------
# results
# --------------------------------------------------------------------------

def normalize_result(
    result: Any,
    layer_ids: list[str],
    start: float,
    end: float,
) -> list[dict[str, Any]]:
    """Whatever the backend returns -> [{layer_id, start, end, text}] in global time."""
    out: list[dict[str, Any]] = []

    def add(layer_id: str, item: Any) -> None:
        if item is None:
            return
        if isinstance(item, str):
            text = item.strip()
            if text:
                out.append({"layer_id": layer_id, "start": start, "end": end, "text": text})
            return
        if isinstance(item, dict):
            text = str(item.get("text") or item.get("content") or "").strip()
            if not text:
                return
            # Times are relative to the slice, which begins at `start`.
            s = start + float(item.get("start", 0.0))
            e = start + float(item["end"]) if item.get("end") is not None else end
            out.append({
                "layer_id": item.get("layer_id", layer_id),
                "start": max(start, min(s, end)),
                "end": max(start, min(e, end)),
                "text": text,
            })
            return
        if isinstance(item, (list, tuple)):
            for sub in item:
                add(layer_id, sub)

    if isinstance(result, str):
        add(layer_ids[0] if layer_ids else "", result)
    elif isinstance(result, dict):
        for layer_id, value in result.items():
            add(str(layer_id), value)
    elif isinstance(result, (list, tuple)):
        for item in result:
            if isinstance(item, dict) and "layer_id" in item:
                add(str(item["layer_id"]), item)
            elif layer_ids:
                add(layer_ids[0], item)

    return [r for r in out if r["end"] - r["start"] > 1e-3 and r["layer_id"]]


# --------------------------------------------------------------------------
# the job body
# --------------------------------------------------------------------------

def run(job: Job, request: dict[str, Any]) -> None:
    """Cut the selection out of each view, hand them to gemini, normalize."""
    work_dir = Path(tempfile.mkdtemp(prefix="annotator-slice-"))
    try:
        job.state = "running"
        root = Path(request["root"])
        start = float(request["start"])
        end = float(request["end"])
        layer_ids = list(request["layer_ids"])

        paths: list[str] = []
        for i, (view_key, segments) in enumerate(request["segments_by_view"].items()):
            _set(job, f"Cutting {view_key}", 0.1 + 0.15 * i, f"{start:.2f}s - {end:.2f}s")
            view_dir = work_dir / f"view-{i}"
            view_dir.mkdir(parents=True, exist_ok=True)
            paths.append(str(slice_range(root, segments, start, end, view_dir)))

        import gemini

        _set(job, "Asking the model", -1.0, f"{len(paths)} clip(s)")
        try:
            result = gemini.annotate(
                paths,
                layer_ids,
                request.get("layer_instructions") or None,
                request.get("context_layer_id") or None,
            )
        except AttributeError as e:
            print(f"Gemini API is not ready: {e}")

        _set(job, "Filling in annotations", 0.97)
        job.result = normalize_result(result, layer_ids, start, end)
        if not job.result:
            raise AutoAnnotateError("The model returned nothing usable for these layers.")
        job.state = "done"
        _set(job, f"{len(job.result)} annotation(s)", 1.0)
    except Exception as err:  # noqa: BLE001 - surfaced to the client verbatim
        job.state = "error"
        job.error = str(err)
        _set(job, "Failed", 1.0)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def start(request: dict[str, Any]) -> Job:
    job = create_job()
    threading.Thread(target=run, args=(job, request), daemon=True).start()
    return job