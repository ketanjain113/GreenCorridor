# AI Emergency Vehicle Detection Backend

This backend bridges your Node.js app with the FastAPI + YOLO model service.

## Features

- Live webcam prediction relay over WebSocket
- Uploaded video prediction as MJPEG stream
- Uploaded video prediction as downloadable MP4

## Run

1. Start FastAPI from `Model/`:

```bash
uvicorn fastapi_server:app --host 0.0.0.0 --port 8000 --reload
```

2. Start Node backend:

```bash
npm --prefix Backend run dev
```

The backend runs at `http://127.0.0.1:4000`.

## Environment (optional)

- `PORT`: backend port (default `4000`)
- `FASTAPI_BASE_URL`: FastAPI base URL (default `http://127.0.0.1:8000`)
- `FASTAPI_WS_URL`: FastAPI WebSocket base (default derived from `FASTAPI_BASE_URL`)

## API

- `GET /health`: Node + FastAPI health
- `POST /api/predict/frame`: multipart form field `frame` (image), returns predicted JPEG
- `POST /api/predict/video/stream`: multipart form field `video`, returns MJPEG stream
- `POST /api/predict/video/file`: multipart form field `video`, returns predicted MP4 download
- `WS /ws/live`: send binary JPEG frames, receive binary JPEG predicted frames

## Browser Webcam Flow

- Capture webcam frame to JPEG in browser canvas
- Send binary frame through backend WebSocket `/ws/live`
- Render returned binary JPEG in an `<img>` or canvas
