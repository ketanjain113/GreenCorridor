import http from "node:http";

import axios from "axios";
import cors from "cors";
import express from "express";
import FormData from "form-data";
import multer from "multer";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 4000);
const FASTAPI_BASE_URL = process.env.FASTAPI_BASE_URL || "http://127.0.0.1:8000";
const FASTAPI_WS_URL =
  process.env.FASTAPI_WS_URL ||
  FASTAPI_BASE_URL.replace("http://", "ws://").replace("https://", "wss://");

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});

app.get("/health", async (_req, res) => {
  try {
    const response = await axios.get(`${FASTAPI_BASE_URL}/health`, { timeout: 5000 });
    res.json({
      status: "ok",
      node: "running",
      fastapi: response.data,
    });
  } catch (error) {
    res.status(502).json({
      status: "error",
      message: "Could not reach FastAPI service",
      details: String(error?.message || error),
    });
  }
});

app.post("/api/predict/frame", upload.single("frame"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "Missing 'frame' file field" });
    return;
  }

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "frame.jpg",
      contentType: req.file.mimetype || "image/jpeg",
    });

    const response = await axios.post(`${FASTAPI_BASE_URL}/predict/frame`, form, {
      headers: form.getHeaders(),
      responseType: "arraybuffer",
      timeout: 30000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    res.setHeader("Content-Type", "image/jpeg");
    res.send(Buffer.from(response.data));
  } catch (error) {
    res.status(502).json({
      message: "Frame inference failed",
      details: error?.response?.data?.detail || String(error?.message || error),
    });
  }
});

app.post("/api/predict/video/file", upload.single("video"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "Missing 'video' file field" });
    return;
  }

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "input.mp4",
      contentType: req.file.mimetype || "video/mp4",
    });

    const response = await axios.post(`${FASTAPI_BASE_URL}/predict/video/file`, form, {
      headers: form.getHeaders(),
      responseType: "stream",
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const disposition = response.headers["content-disposition"];
    if (disposition) {
      res.setHeader("Content-Disposition", disposition);
    } else {
      res.setHeader("Content-Disposition", "attachment; filename=predicted_video.mp4");
    }

    res.setHeader("Content-Type", response.headers["content-type"] || "video/mp4");
    response.data.pipe(res);
  } catch (error) {
    res.status(502).json({
      message: "Video file inference failed",
      details: error?.response?.data?.detail || String(error?.message || error),
    });
  }
});

app.post("/api/predict/video/stream", upload.single("video"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ message: "Missing 'video' file field" });
    return;
  }

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "input.mp4",
      contentType: req.file.mimetype || "video/mp4",
    });

    const response = await axios.post(`${FASTAPI_BASE_URL}/predict/video/stream`, form, {
      headers: form.getHeaders(),
      responseType: "stream",
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    res.setHeader(
      "Content-Type",
      response.headers["content-type"] || "multipart/x-mixed-replace; boundary=frame",
    );
    response.data.pipe(res);
  } catch (error) {
    res.status(502).json({
      message: "Video stream inference failed",
      details: error?.response?.data?.detail || String(error?.message || error),
    });
  }
});

const wss = new WebSocketServer({ server, path: "/ws/live" });

wss.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the existing backend process or run with PORT=4001`,
    );
    process.exit(1);
  }

  console.error("WebSocket server error:", error);
  process.exit(1);
});

wss.on("connection", (clientSocket) => {
  const aiSocket = new WebSocket(`${FASTAPI_WS_URL}/ws/live`);

  aiSocket.on("open", () => {
    clientSocket.send(JSON.stringify({ type: "ready" }));
  });

  clientSocket.on("message", (data, isBinary) => {
    if (aiSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (isBinary) {
      aiSocket.send(data, { binary: true });
      return;
    }

    const text = data.toString();
    if (text === "ping") {
      clientSocket.send("pong");
    }
  });

  aiSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    clientSocket.send(data, { binary: isBinary });
  });

  const cleanup = () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
    if (aiSocket.readyState === WebSocket.OPEN || aiSocket.readyState === WebSocket.CONNECTING) {
      aiSocket.close();
    }
  };

  clientSocket.on("close", cleanup);
  aiSocket.on("close", cleanup);

  clientSocket.on("error", cleanup);
  aiSocket.on("error", (err) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(
        JSON.stringify({
          type: "error",
          message: `FastAPI WebSocket error: ${err.message}`,
        }),
      );
    }
    cleanup();
  });
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the existing backend process or run with a different PORT, e.g. PORT=4001 npm run start`,
    );
    process.exit(1);
  }

  console.error("Backend server error:", error);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Node backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Proxy target FastAPI: ${FASTAPI_BASE_URL}`);
});
