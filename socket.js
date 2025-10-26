import { io } from "socket.io-client";

const URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:5000";

export const socket = io(URL, {
  autoConnect: true,
  withCredentials: true,
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
});

socket.on("connect_error", (err) => {
  console.log("connect_error:", err.message, err);
});
socket.on("reconnect_attempt", (n) => console.log("reconnect_attempt", n));
socket.on("reconnect", (n) => console.log("reconnected after", n, "tries"));
socket.on("reconnect_error", (e) => console.log("reconnect_error", e));
socket.on("reconnect_failed", () => console.log("reconnect_failed"));




