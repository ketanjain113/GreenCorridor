from __future__ import annotations

import os
import tempfile
import shutil
import subprocess
from pathlib import Path
from typing import AsyncGenerator

import cv2
import numpy as np
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from Video_layer import (
    DEFAULT_ALERT_WEIGHTS_PATH,
    DEFAULT_WEIGHTS_PATH,
    AlertVideoAnalyzer,
    VideoPredictor,
)

app = FastAPI(title="GreenCorridor Vision API", version="1.0.0")

predictor: VideoPredictor | None = None
alert_analyzer: AlertVideoAnalyzer | None = None
ALERT_VEHICLE_THRESHOLD = int(os.getenv("ALERT_VEHICLE_THRESHOLD", "20"))


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _transcode_to_web_mp4(input_path: Path, output_path: Path) -> bool:
    """Convert OpenCV mp4 output to H.264 + yuv420p for browser playback."""
    ffmpeg_candidates = [
        os.getenv("FFMPEG_BIN", "").strip(),
        shutil.which("ffmpeg") or "",
        str(Path.home() / "AppData" / "Local" / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe"),
    ]
    ffmpeg_bin = next((candidate for candidate in ffmpeg_candidates if candidate and Path(candidate).exists()), None)
    if not ffmpeg_bin:
        return False

    cmd = [
        ffmpeg_bin,
        "-y",
        "-i",
        str(input_path),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        str(output_path),
    ]

    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return output_path.exists() and output_path.stat().st_size > 0
    except (subprocess.CalledProcessError, OSError):
        return False


@app.on_event("startup")
def load_model() -> None:
    global predictor, alert_analyzer
    predictor = VideoPredictor(weights_path=DEFAULT_WEIGHTS_PATH)
    try:
        alert_analyzer = AlertVideoAnalyzer(weights_path=DEFAULT_ALERT_WEIGHTS_PATH)
    except Exception as exc:
        alert_analyzer = None
        print(f"[startup] alert model unavailable: {exc}")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_loaded": predictor is not None,
        "alert_model_loaded": alert_analyzer is not None,
        "weights": str(DEFAULT_WEIGHTS_PATH),
        "alert_weights": str(DEFAULT_ALERT_WEIGHTS_PATH),
        "alert_vehicle_threshold": ALERT_VEHICLE_THRESHOLD,
    }


@app.get("/tracking/latest")
def tracking_latest() -> dict:
    if predictor is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    return {
        "status": "ok",
        "tracked_objects": predictor.latest_tracked_objects,
        "speed_eta": predictor.latest_speed_eta,
        "distance_to_signal": predictor.next_signal_distance,
    }


@app.post("/predict/frame")
async def predict_frame(file: UploadFile = File(...)) -> Response:
    """
    Accept one image frame (jpeg/png) and return annotated jpeg bytes.
    This is ideal when Node sends each camera frame over HTTP.
    """
    if predictor is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty frame payload")

    frame_array = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)

    if frame_array is None:
        raise HTTPException(status_code=400, detail="Could not decode image frame")

    annotated = predictor.annotate_frame(frame_array)
    ok, encoded = cv2.imencode(".jpg", annotated)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to encode annotated frame")

    return Response(content=encoded.tobytes(), media_type="image/jpeg")


@app.websocket("/ws/live")
async def ws_live_prediction(websocket: WebSocket) -> None:
    """
    Receive binary jpeg frames from Node and return annotated jpeg frames.
    """
    if predictor is None:
        await websocket.close(code=1011, reason="Model is not loaded")
        return

    await websocket.accept()

    try:
        while True:
            payload = await websocket.receive_bytes()
            frame = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                await websocket.send_text("decode_error")
                continue

            annotated = predictor.annotate_frame(frame)
            ok, encoded = cv2.imencode(".jpg", annotated)
            if not ok:
                await websocket.send_text("encode_error")
                continue

            await websocket.send_bytes(encoded.tobytes())
    except WebSocketDisconnect:
        return


async def _mjpeg_from_video(input_video_path: Path) -> AsyncGenerator[bytes, None]:
    if predictor is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    cap = cv2.VideoCapture(str(input_video_path))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open uploaded video")

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            annotated = predictor.annotate_frame(frame)
            encoded_ok, jpg = cv2.imencode(".jpg", annotated)
            if not encoded_ok:
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + jpg.tobytes()
                + b"\r\n"
            )
    finally:
        cap.release()
        _safe_unlink(input_video_path)


@app.post("/predict/video/stream")
async def predict_video_stream(file: UploadFile = File(...)) -> StreamingResponse:
    """
    Accept a video upload and stream real-time annotated frames as MJPEG.
    """
    suffix = Path(file.filename or "input.mp4").suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(await file.read())

    return StreamingResponse(
        _mjpeg_from_video(temp_path),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@app.post("/predict/video/file")
async def predict_video_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> FileResponse:
    """
    Accept a video and return a processed mp4 file.
    """
    if predictor is None:
        raise HTTPException(status_code=503, detail="Model is not loaded")

    print(f"[fastapi video/file] request received filename={file.filename} type={file.content_type}")

    if file.content_type and not file.content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="Uploaded file is not a video")

    in_suffix = Path(file.filename or "input.mp4").suffix or ".mp4"

    with tempfile.NamedTemporaryFile(delete=False, suffix=in_suffix) as input_temp:
        input_path = Path(input_temp.name)
        payload = await file.read()
        if not payload:
            raise HTTPException(status_code=400, detail="Uploaded video is empty")
        input_temp.write(payload)

    print(f"[fastapi video/file] upload saved to {input_path} bytes={len(payload)}")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as output_temp:
        output_path = Path(output_temp.name)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as output_web_temp:
        output_web_path = Path(output_web_temp.name)

    alert_summary = {
        "max_vehicles": 0,
        "avg_vehicles": 0.0,
    }

    try:
        print(f"[fastapi video/file] starting model inference -> {output_path}")
        await run_in_threadpool(predictor.process_video, input_path, output_path)
        if alert_analyzer is not None:
            alert_summary = await run_in_threadpool(alert_analyzer.analyze_video, input_path)
        print(f"[fastapi video/file] inference complete, starting transcode -> {output_web_path}")
        web_ready = await run_in_threadpool(_transcode_to_web_mp4, output_path, output_web_path)
        print(f"[fastapi video/file] transcode complete web_ready={web_ready}")
    except Exception as exc:
        _safe_unlink(input_path)
        _safe_unlink(output_path)
        _safe_unlink(output_web_path)
        print(f"Video processing failed for {file.filename}: {exc}")
        raise HTTPException(status_code=500, detail=f"Video processing failed: {exc}") from exc

    serving_path = output_web_path if web_ready else output_path
    max_vehicles = int(alert_summary.get("max_vehicles", 0))
    avg_vehicles = float(alert_summary.get("avg_vehicles", 0.0))
    traffic_alert_triggered = max_vehicles > ALERT_VEHICLE_THRESHOLD

    print(f"[fastapi video/file] returning {serving_path}")

    _safe_unlink(input_path)
    background_tasks.add_task(_safe_unlink, output_path)
    background_tasks.add_task(_safe_unlink, output_web_path)

    return FileResponse(
        path=str(serving_path),
        filename=f"predicted_{Path(file.filename or 'video').stem}.mp4",
        media_type="video/mp4",
        headers={
            "X-Traffic-Alert": "1" if traffic_alert_triggered else "0",
            "X-Vehicle-Count-Max": str(max_vehicles),
            "X-Vehicle-Count-Avg": f"{avg_vehicles:.2f}",
            "X-Alert-Threshold": str(ALERT_VEHICLE_THRESHOLD),
        },
    )


# Run with:
# uvicorn fastapi_server:app --host 0.0.0.0 --port 8000 --reload
