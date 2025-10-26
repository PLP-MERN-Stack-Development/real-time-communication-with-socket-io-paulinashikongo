import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
// import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
});

// ---- Presence ----
const onlineUsers = new Map(); // socket.id -> { username }
const presenceList = () =>
  Array.from(onlineUsers.entries()).map(([id, u]) => ({ id, username: u.username }));

// ---- In-memory history (for pagination) ----
const MAX_HISTORY = 500;
const globalHistory = [];                 // Array of message objects
const roomHistory = new Map();            // room -> Array<message>
const dmHistory = new Map();              // key(a|b) -> Array<message>
const dmKey = (a, b) => [a, b].sort().join("|");
const pushBounded = (arr, item) => { arr.push(item); if (arr.length > MAX_HISTORY) arr.shift(); };

io.on("connection", (socket) => {
  console.log("✅ socket connected:", socket.id, "from", socket.handshake.headers.origin);

  // --- Join / presence ---
  socket.on("user:join", ({ username }) => {
    socket.data.username = (username || "Anonymous").trim() || "Anonymous";
    onlineUsers.set(socket.id, { username: socket.data.username });
    io.emit("presence:list", presenceList());
    socket.emit("server:welcome", { message: `Welcome, ${socket.data.username}!`, id: socket.id });
    // auto-join a default room only if the client requests it; (client does this)
  });

  // --- Global chat (with ack + history) ---
  socket.on("chat:message", ({ text, file }, ack) => {
    const username = socket.data.username || "Anonymous";
    const trimmed = (text || "").trim();
    if (!trimmed && !file) return;

    const msg = {
      // id: randomUUID(),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      scope: "global",
      userId: socket.id,
      username,
      text: trimmed,
      file, // {name,type,dataUrl,size?}
      ts: new Date().toISOString(),
    };

    pushBounded(globalHistory, msg);
    io.emit("chat:message", msg);
    if (typeof ack === "function") ack({ ok: true, id: msg.id, ts: msg.ts });
  });

  // --- Rooms (with ack + history) ---
  socket.on("room:join", ({ room }) => {
    const r = (room || "").trim();
    if (!r) return;
    socket.join(r);
    io.to(r).emit("room:system", { room: r, text: `${socket.data.username} joined`, ts: Date.now() });
  });

  socket.on("room:leave", ({ room }) => {
    const r = (room || "").trim();
    if (!r) return;
    socket.leave(r);
    io.to(r).emit("room:system", { room: r, text: `${socket.data.username} left`, ts: Date.now() });
  });

  socket.on("room:message", ({ room, text, file }, ack) => {
    const r = (room || "").trim();
    if (!r) return;
    const username = socket.data.username || "Anonymous";
    const trimmed = (text || "").trim();
    if (!trimmed && !file) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      scope: "room",
      room: r,
      userId: socket.id,
      username,
      text: trimmed,
      file,
      ts: new Date().toISOString(),
    };

    const arr = roomHistory.get(r) || [];
    pushBounded(arr, msg);
    roomHistory.set(r, arr);

    io.to(r).emit("room:message", msg);
    if (typeof ack === "function") ack({ ok: true, id: msg.id, ts: msg.ts });
  });

  // --- Direct messages (with ack + history) ---
  socket.on("dm:send", ({ to, text, file }, ack) => {
    const target = (to || "").trim();
    const username = socket.data.username || "Anonymous";
    const trimmed = (text || "").trim();
    if (!target || (!trimmed && !file)) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      scope: "dm",
      from: socket.id,
      to: target,
      username,
      text: trimmed,
      file,
      ts: new Date().toISOString(),
    };

    const key = dmKey(socket.id, target);
    const arr = dmHistory.get(key) || [];
    pushBounded(arr, msg);
    dmHistory.set(key, arr);

    // deliver to receiver and echo to sender
    io.to(target).emit("dm:message", msg);
    socket.emit("dm:message", msg);
    if (typeof ack === "function") ack({ ok: true, id: msg.id, ts: msg.ts });
  });

  // --- Typing (global / room / dm) ---
  socket.on("typing", ({ isTyping, scope = "global", room, to }) => {
    const payload = {
      userId: socket.id,
      username: socket.data.username || "Anonymous",
      isTyping: !!isTyping,
      scope,
      room,
      to,
    };
    if (scope === "dm" && to) {
      socket.to(to).emit("typing", payload);
    } else if (scope === "room" && room) {
      socket.to(room).emit("typing", payload);
    } else {
      socket.broadcast.emit("typing", payload);
    }
  });

  // --- Read receipts ---
  socket.on("message:read", ({ messageId, scope, room, otherUserId }) => {
    const payload = { messageId, readerId: socket.id, scope, room };
    if (scope === "dm" && otherUserId) {
      io.to(otherUserId).emit("message:read", payload);
    } else if (scope === "room" && room) {
      socket.to(room).emit("message:read", payload);
    } else {
      socket.broadcast.emit("message:read", payload);
    }
  });

  // --- Reactions ---
  socket.on("message:react", ({ messageId, reaction, scope, room, otherUserId }) => {
    const payload = {
      messageId,
      reaction,
      from: socket.id,
      username: socket.data.username || "Anonymous",
      scope,
      room,
    };
    if (scope === "dm" && otherUserId) {
      io.to(otherUserId).emit("message:react", payload);
      socket.emit("message:react", payload);
    } else if (scope === "room" && room) {
      io.to(room).emit("message:react", payload);
    } else {
      io.emit("message:react", payload);
    }
  });

  // --- History fetch (pagination) ---
  socket.on("history:fetch", ({ scope, before, limit = 25, room, otherUserId }, cb) => {
    let source = [];
    if (scope === "global") {
      source = globalHistory;
    } else if (scope === "room" && room) {
      source = roomHistory.get(room) || [];
    } else if (scope === "dm" && otherUserId) {
      const key = dmKey(socket.id, otherUserId);
      source = dmHistory.get(key) || [];
    } else {
      cb && cb({ items: [] });
      return;
    }

    const beforeMs = before ? new Date(before).getTime() : Number.POSITIVE_INFINITY;
    const filtered = source.filter((m) => new Date(m.ts).getTime() < beforeMs);
    const page = filtered.slice(Math.max(0, filtered.length - limit)); // last N older-than-before
    cb && cb({ items: page });
  });

  // --- Disconnect ---
  socket.on("disconnect", (reason) => {
    const username = socket.data.username || "Anonymous";
    onlineUsers.delete(socket.id);
    io.emit("presence:list", presenceList());
    console.log("❌ disconnected:", username, socket.id, reason);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`);
});
