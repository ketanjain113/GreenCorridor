from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any, Optional

import cv2
import torch
from ultralytics import YOLO

DEFAULT_CONFIDENCE = 0.35
DEFAULT_WEIGHTS_PATH = Path(__file__).resolve().with_name("best.pt")
DEFAULT_ALERT_WEIGHTS_PATH = Path(__file__).resolve().with_name("alert.pt")
DEFAULT_IMAGE_SIZE = 640
DEFAULT_NEXT_SIGNAL_DISTANCE = 300.0
DEFAULT_GREEN_ETA_THRESHOLD_SECONDS = 10.0


def decide_signal_state(eta: float | None, green_threshold_seconds: float = DEFAULT_GREEN_ETA_THRESHOLD_SECONDS) -> dict[str, Any]:
    """Return traffic signal state from ETA.

    Rule:
    - eta < threshold => GREEN
    - otherwise => RED
    """
    signal = "GREEN" if eta is not None and eta < green_threshold_seconds else "RED"
    return {
        "signal": signal,
        "eta": eta,
    }


class VideoPredictor:
    """Loads YOLO weights once and exposes frame/video tracking helpers."""

    def __init__(
        self,
        weights_path: Optional[str | Path] = None,
        confidence: float = DEFAULT_CONFIDENCE,
        device: Optional[str | int] = None,
        imgsz: int = DEFAULT_IMAGE_SIZE,
    ) -> None:
        resolved_weights = Path(weights_path) if weights_path else DEFAULT_WEIGHTS_PATH
        if not resolved_weights.exists():
            raise FileNotFoundError(f"Model weights not found: {resolved_weights}")

        self.weights_path = resolved_weights
        self.confidence = confidence
        self.device = device if device is not None else (0 if torch.cuda.is_available() else "cpu")
        self.imgsz = imgsz
        self.use_half = self.device != "cpu"
        self.model = YOLO(str(self.weights_path))
        self.next_signal_distance = DEFAULT_NEXT_SIGNAL_DISTANCE
        self.previous_positions: dict[int, tuple[tuple[float, float], float]] = {}
        self.latest_tracked_objects: list[dict[str, Any]] = []
        self.latest_speed_eta: list[dict[str, Any]] = []

    def _track_frame(self, frame):
        """Run YOLO tracking on a single BGR frame."""
        results = self.model.track(
            frame,
            conf=self.confidence,
            device=self.device,
            imgsz=self.imgsz,
            half=self.use_half,
            max_det=20,
            persist=True,
            verbose=False,
        )
        return results[0]

    def extract_tracked_objects(self, result) -> list[dict[str, Any]]:
        """Convert a YOLO result to structured tracked-object records."""
        tracked_objects: list[dict[str, Any]] = []
        boxes = result.boxes
        if boxes is None or getattr(boxes, "xyxy", None) is None:
            return tracked_objects

        names = result.names if isinstance(result.names, dict) else {}
        xyxy = boxes.xyxy.cpu().tolist()
        cls_values = boxes.cls.cpu().tolist() if getattr(boxes, "cls", None) is not None else []
        id_values = boxes.id.int().cpu().tolist() if getattr(boxes, "id", None) is not None else []

        for index, coords in enumerate(xyxy):
            cls_idx = int(cls_values[index]) if index < len(cls_values) else -1
            track_id = int(id_values[index]) if index < len(id_values) else -1
            label = names.get(cls_idx, str(cls_idx))

            x1, y1, x2, y2 = [int(v) for v in coords]
            tracked_objects.append(
                {
                    "id": track_id,
                    "label": label,
                    "bbox": [x1, y1, x2, y2],
                }
            )

        return tracked_objects

    @staticmethod
    def _bbox_center(bbox: list[int]) -> tuple[float, float]:
        x1, y1, x2, y2 = bbox
        return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)

    def compute_speed_eta(self, tracked_objects: list[dict[str, Any]], timestamp: float | None = None) -> list[dict[str, Any]]:
        """Compute speed and ETA per track ID using previous center positions."""
        current_time = timestamp if timestamp is not None else time.monotonic()
        speed_eta_records: list[dict[str, Any]] = []

        for tracked in tracked_objects:
            track_id = int(tracked.get("id", -1))
            if track_id < 0:
                continue

            center = self._bbox_center(tracked["bbox"])
            previous = self.previous_positions.get(track_id)
            speed = 0.0
            eta: float | None = None

            if previous is not None:
                (prev_x, prev_y), prev_time = previous
                time_difference = current_time - prev_time
                if time_difference > 0:
                    pixel_distance = ((center[0] - prev_x) ** 2 + (center[1] - prev_y) ** 2) ** 0.5
                    speed = pixel_distance / time_difference
                    if speed > 0:
                        eta = self.next_signal_distance / speed

            self.previous_positions[track_id] = (center, current_time)
            signal_decision = decide_signal_state(eta)
            speed_eta_records.append(
                {
                    "id": track_id,
                    "speed": speed,
                    "eta": eta,
                    "signal": signal_decision["signal"],
                }
            )

        return speed_eta_records

    def annotate_frame_with_tracks(self, frame):
        """Track objects on a frame and return (annotated_frame, tracked_objects)."""
        result = self._track_frame(frame)
        tracked_objects = self.extract_tracked_objects(result)
        speed_eta_records = self.compute_speed_eta(tracked_objects)
        self.latest_tracked_objects = tracked_objects
        self.latest_speed_eta = speed_eta_records
        annotated = result.plot()

        status_text = f"AI Tracking | Tracked Objects: {len(tracked_objects)}"

        # Draw an always-visible status bar so output video clearly shows AI processing.
        cv2.rectangle(annotated, (10, 10), (610, 42), (15, 23, 42), -1)
        cv2.putText(
            annotated,
            status_text,
            (18, 33),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.58,
            (255, 255, 255),
            2,
            cv2.LINE_AA,
        )

        return annotated, tracked_objects

    def annotate_frame(self, frame):
        """Track objects on a BGR frame and return the annotated frame."""
        annotated, _tracked_objects = self.annotate_frame_with_tracks(frame)
        return annotated

    def process_video(
        self,
        input_video_path: str | Path,
        output_video_path: str | Path,
        force_fps: Optional[float] = None,
    ) -> Path:
        """Process a full video file and save annotated output."""
        input_path = Path(input_video_path)
        output_path = Path(output_video_path)

        if not input_path.exists():
            raise FileNotFoundError(f"Input video not found: {input_path}")

        cap = cv2.VideoCapture(str(input_path))
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video: {input_path}")

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = force_fps if force_fps is not None else cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps <= 0:
            fps = 30

        output_path.parent.mkdir(parents=True, exist_ok=True)
        writer = cv2.VideoWriter(
            str(output_path),
            cv2.VideoWriter_fourcc(*"mp4v"),
            fps,
            (width, height),
        )

        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                writer.write(self.annotate_frame(frame))
        finally:
            cap.release()
            writer.release()

        return output_path.resolve()


class AlertVideoAnalyzer:
    """Runs a second YOLO model pass to estimate traffic density without rendering output."""

    def __init__(
        self,
        weights_path: Optional[str | Path] = None,
        confidence: float = DEFAULT_CONFIDENCE,
        device: Optional[str | int] = None,
        imgsz: int = DEFAULT_IMAGE_SIZE,
    ) -> None:
        resolved_weights = Path(weights_path) if weights_path else DEFAULT_ALERT_WEIGHTS_PATH
        if not resolved_weights.exists():
            raise FileNotFoundError(f"Alert model weights not found: {resolved_weights}")

        self.weights_path = resolved_weights
        self.confidence = confidence
        self.device = device if device is not None else (0 if torch.cuda.is_available() else "cpu")
        self.imgsz = imgsz
        self.use_half = self.device != "cpu"
        self.model = YOLO(str(self.weights_path))

    def analyze_video(self, input_video_path: str | Path) -> dict:
        """Return max and average detected vehicle counts across a video."""
        input_path = Path(input_video_path)
        if not input_path.exists():
            raise FileNotFoundError(f"Input video not found: {input_path}")

        cap = cv2.VideoCapture(str(input_path))
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video for alert analysis: {input_path}")

        max_count = 0
        total_count = 0
        analyzed_frames = 0

        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break

                results = self.model.predict(
                    frame,
                    conf=self.confidence,
                    device=self.device,
                    imgsz=self.imgsz,
                    half=self.use_half,
                    max_det=200,
                    verbose=False,
                )

                boxes = results[0].boxes
                count = int(len(boxes)) if boxes is not None else 0
                max_count = max(max_count, count)
                total_count += count
                analyzed_frames += 1
        finally:
            cap.release()

        avg_count = (total_count / analyzed_frames) if analyzed_frames else 0.0
        return {
            "max_vehicles": max_count,
            "avg_vehicles": avg_count,
            "frames_analyzed": analyzed_frames,
        }


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run video inference using best.pt")
    parser.add_argument("--input", required=True, help="Path to input video file")
    parser.add_argument("--output", default="output_detected.mp4", help="Path to output annotated mp4")
    parser.add_argument("--weights", default=str(DEFAULT_WEIGHTS_PATH), help="Path to YOLO .pt file")
    parser.add_argument("--conf", type=float, default=DEFAULT_CONFIDENCE, help="Inference confidence threshold")
    parser.add_argument("--device", default=None, help="Device: cpu, 0, 1, etc.")
    return parser


def main() -> None:
    parser = _build_arg_parser()
    args = parser.parse_args()

    predictor = VideoPredictor(weights_path=args.weights, confidence=args.conf, device=args.device)
    output = predictor.process_video(args.input, args.output)
    print(f"Done. Saved: {output}")


if __name__ == "__main__":
    main()
