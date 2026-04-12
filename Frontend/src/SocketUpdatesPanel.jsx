import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

const BACKEND_SOCKET_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.DEV ? "http://127.0.0.1:4000" : window.location.origin);

export default function SocketUpdatesPanel({ maxItems = 20 }) {
  const [updates, setUpdates] = useState([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io(BACKEND_SOCKET_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 300,
    });

    const handleConnect = () => setConnected(true);
    const handleDisconnect = () => setConnected(false);
    const handleUpdate = (payload) => {
      setUpdates((prev) => [payload, ...prev].slice(0, maxItems));
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("update", handleUpdate);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("update", handleUpdate);
      socket.disconnect();
    };
  }, [maxItems]);

  const latest = useMemo(() => updates[0] || null, [updates]);

  return (
    <section style={{ border: "1px solid #d8dee8", borderRadius: 12, padding: 12 }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <strong>Live Vehicle Updates</strong>
        <span style={{ color: connected ? "#0f9d58" : "#c0392b" }}>
          {connected ? "Connected" : "Disconnected"}
        </span>
      </header>

      {latest ? (
        <div style={{ marginBottom: 10, padding: 10, background: "#f7f9fc", borderRadius: 8 }}>
          <div><strong>Vehicle:</strong> {latest.vehicle}</div>
          <div><strong>ETA:</strong> {latest.eta ?? "N/A"}</div>
          <div><strong>Signal:</strong> {latest.signal}</div>
          <div>
            <strong>Position:</strong> [{latest.position?.[0] ?? "-"}, {latest.position?.[1] ?? "-"}]
          </div>
        </div>
      ) : (
        <p style={{ marginTop: 0 }}>Waiting for update events...</p>
      )}

      <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflowY: "auto" }}>
        {updates.map((item, idx) => (
          <li key={`${item.vehicle}-${item.eta}-${idx}`} style={{ marginBottom: 6 }}>
            {item.vehicle} | ETA: {item.eta ?? "N/A"} | Signal: {item.signal} | Pos: [
            {item.position?.[0] ?? "-"}, {item.position?.[1] ?? "-"}]
          </li>
        ))}
      </ul>
    </section>
  );
}
