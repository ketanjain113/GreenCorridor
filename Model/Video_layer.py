from __future__ import annotations

import argparse
from pathlib import Path
from typing import Optional

import cv2
import torch
from ultralytics import YOLO

DEFAULT_CONFIDENCE = 0.35
DEFAULT_WEIGHTS_PATH = Path(__file__).resolve().with_name("best.pt")
DEFAULT_ALERT_WEIGHTS_PATH = Path(__file__).resolve().with_name("alert.pt")
DEFAULT_IMAGE_SIZE = 640


class VideoPredictor:
    """Loads YOLO weights once and exposes frame/video inference helpers."""

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

    def annotate_frame(self, frame):
        """Run inference on a BGR frame and return the annotated frame."""
        results = self.model.predict(
            frame,
            conf=self.confidence,
            device=self.device,
            imgsz=self.imgsz,
            half=self.use_half,
            max_det=20,
            verbose=False,
        )
        annotated = results[0].plot()

        boxes = results[0].boxes
        detection_count = int(len(boxes)) if boxes is not None else 0
        max_confidence = 0.0

        if boxes is not None and getattr(boxes, "conf", None) is not None and len(boxes.conf) > 0:
            max_confidence = float(boxes.conf.max().item())

        status_text = (
            f"AI Processed | Detections: {detection_count} | Max Confidence: {max_confidence * 100:.1f}%"
        )

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
