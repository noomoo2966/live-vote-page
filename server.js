const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const INDEX_PATH = path.join(__dirname, "index.html");
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "rooms.json");
const FIXED_ROOM_ID = normalizeRoomId(process.env.FIXED_ROOM_ID || "LIVE");
const tools = [
  { id: 1, name: "报价单生成器" },
  { id: 2, name: "装箱计算器 / 柜型建议器" },
  { id: 3, name: "质量计算小工具" },
  { id: 4, name: "铭牌参数生成器" },
  { id: 5, name: "电子签报销单 + 对账工具" },
  { id: 6, name: "日程管理小助手" },
];

const rooms = new Map();
let lastRoomId = "";

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function serializeRoom(room) {
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    startedAt: room.startedAt,
    startAt: room.startAt,
    durationMs: room.durationMs,
    started: room.started,
    ended: room.ended,
    endedAt: room.endedAt,
    votes: room.votes,
    touchAt: room.touchAt,
    ballots: room.ballots,
    confirmedAt: room.confirmedAt,
    confirmedOrder: room.confirmedOrder,
  };
}

function hydrateRoom(raw) {
  return {
    roomId: raw.roomId,
    createdAt: raw.createdAt || now(),
    updatedAt: raw.updatedAt || now(),
    startedAt: raw.startedAt ?? null,
    startAt: raw.startAt ?? null,
    durationMs: raw.durationMs || 60 * 1000,
    started: Boolean(raw.started),
    ended: Boolean(raw.ended),
    endedAt: raw.endedAt ?? null,
    votes: { ...blankVotes(), ...(raw.votes || {}) },
    touchAt: { ...blankTouchAt(), ...(raw.touchAt || {}) },
    ballots: raw.ballots || {},
    confirmedAt: raw.confirmedAt ?? null,
    confirmedOrder: Array.isArray(raw.confirmedOrder) ? raw.confirmedOrder : [],
    timer: null,
    subscribers: new Set(),
  };
}

function persistRooms() {
  ensureDataDir();
  const payload = {
    lastRoomId,
    rooms: Object.fromEntries([...rooms.entries()].map(([roomId, room]) => [roomId, serializeRoom(room)])),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
}

function loadRooms() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    lastRoomId = raw.lastRoomId || "";
    for (const [roomId, data] of Object.entries(raw.rooms || {})) {
      rooms.set(roomId, hydrateRoom({ ...data, roomId }));
    }
  } catch {
    // Ignore corrupt persistence.
  }
}

loadRooms();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }
  return "127.0.0.1";
}

function normalizeRoomId(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 32);
}

function getPublicBaseUrl(req) {
  const forced = process.env.PUBLIC_BASE_URL;
  if (forced) return forced.replace(/\/$/, "");
  const host = getLocalIp();
  const protocol = req?.socket?.encrypted ? "https" : "http";
  return `${protocol}://${host}:${PORT}`;
}

function now() {
  return Date.now();
}

function blankVotes() {
  return Object.fromEntries(tools.map((tool) => [tool.id, 0]));
}

function blankTouchAt() {
  return Object.fromEntries(tools.map((tool) => [tool.id, 0]));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createRoom(durationMs = 60 * 1000, requestedRoomId = "") {
  const normalizedRequestedRoomId = normalizeRoomId(requestedRoomId);
  const roomId = normalizedRequestedRoomId || makeRoomId();

  if (rooms.has(roomId)) {
    return resetRoom(rooms.get(roomId), durationMs);
  }

  const room = {
    roomId,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    startAt: null,
    durationMs,
    started: false,
    ended: false,
    endedAt: null,
    votes: blankVotes(),
    touchAt: blankTouchAt(),
    ballots: {},
    confirmedAt: null,
    confirmedOrder: [],
    timer: null,
    subscribers: new Set(),
  };

  rooms.set(roomId, room);
  lastRoomId = roomId;
  persistRooms();
  scheduleEnd(room);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function ranking(room) {
  return [...tools].sort((a, b) => {
    const diff = (room.votes[b.id] || 0) - (room.votes[a.id] || 0);
    if (diff !== 0) return diff;
    return (room.touchAt[a.id] || 0) - (room.touchAt[b.id] || 0);
  });
}

function ensureExpired(room) {
  if (room.started && !room.ended && room.startAt + room.durationMs <= now()) {
    endRoom(room);
  }
}

function publicState(room) {
  ensureExpired(room);
  return {
    roomId: room.roomId,
    started: room.started,
    startedAt: room.startedAt,
    startAt: room.startAt,
    durationMs: room.durationMs,
    ended: room.ended,
    endedAt: room.endedAt,
    votes: clone(room.votes),
    touchAt: clone(room.touchAt),
    ballots: clone(room.ballots),
    confirmedAt: room.confirmedAt,
    confirmedOrder: clone(room.confirmedOrder),
    serverNow: now(),
  };
}

if (FIXED_ROOM_ID) {
  if (!rooms.has(FIXED_ROOM_ID)) {
    createRoom(60 * 1000, FIXED_ROOM_ID);
  } else {
    lastRoomId = FIXED_ROOM_ID;
  }
}

for (const room of rooms.values()) {
  ensureExpired(room);
  if (room.started && !room.ended) {
    scheduleEnd(room);
  }
}

function broadcast(room) {
  const payload = `data: ${JSON.stringify({ state: publicState(room) })}\n\n`;
  for (const res of room.subscribers) {
    try {
      res.write(payload);
    } catch {
      room.subscribers.delete(res);
    }
  }
}

function scheduleEnd(room) {
  if (room.timer) clearTimeout(room.timer);
  if (!room.started || room.ended) return;
  const remaining = Math.max(0, room.startAt + room.durationMs - now());
  room.timer = setTimeout(() => {
    endRoom(room);
  }, remaining);
}

function startRoom(room) {
  if (room.started && !room.ended) return room;
  room.started = true;
  room.startedAt = now();
  room.startAt = room.startedAt;
  room.ended = false;
  room.endedAt = null;
  room.updatedAt = now();
  lastRoomId = room.roomId;
  persistRooms();
  scheduleEnd(room);
  broadcast(room);
  return room;
}

function endRoom(room) {
  if (room.ended) return;
  room.ended = true;
  room.endedAt = now();
  if (!room.confirmedOrder.length) {
    room.confirmedOrder = ranking(room).map((tool) => tool.id);
  }
  room.updatedAt = now();
  lastRoomId = room.roomId;
  persistRooms();
  broadcast(room);
}

function resetRoom(room, durationMs = 60 * 1000) {
  room.started = false;
  room.startedAt = null;
  room.startAt = null;
  room.durationMs = durationMs;
  room.ended = false;
  room.endedAt = null;
  room.votes = blankVotes();
  room.touchAt = blankTouchAt();
  room.ballots = {};
  room.confirmedAt = null;
  room.confirmedOrder = [];
  room.updatedAt = now();
  lastRoomId = room.roomId;
  persistRooms();
  scheduleEnd(room);
  broadcast(room);
  return room;
}

function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function serveIndex(res) {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

function serveIndexHead(res) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const { pathname } = requestUrl;

    if (req.method === "GET" && pathname === "/api/ping") {
      return sendJson(res, 200, { ok: true, baseUrl: getPublicBaseUrl(req), defaultRoomId: FIXED_ROOM_ID || "" });
    }

    if (req.method === "GET" && pathname === "/api/meta") {
      return sendJson(res, 200, {
        ok: true,
        baseUrl: getPublicBaseUrl(req),
        defaultRoomId: FIXED_ROOM_ID || "",
        lastRoomId,
      });
    }

    if (req.method === "OPTIONS" && pathname.startsWith("/api/")) {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
      });
      return res.end();
    }

    if (req.method === "GET" && pathname === "/api/state") {
      const roomId = requestUrl.searchParams.get("roomId");
      if (!roomId) return sendJson(res, 400, { error: "roomId is required" });
      const room = getRoom(roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      return sendJson(res, 200, { state: publicState(room) });
    }

    if (req.method === "GET" && pathname === "/events") {
      const roomId = requestUrl.searchParams.get("roomId");
      if (!roomId) return sendJson(res, 400, { error: "roomId is required" });
      const room = getRoom(roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });

      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(`data: ${JSON.stringify({ state: publicState(room) })}\n\n`);
      room.subscribers.add(res);

      req.on("close", () => {
        room.subscribers.delete(res);
      });

      return;
    }

    if (req.method === "POST" && pathname === "/api/rooms") {
      const body = await parseJson(req);
      const room = createRoom(Number(body.durationMs) || 60 * 1000, body.roomId);
      return sendJson(res, 200, { roomId: room.roomId, state: publicState(room) });
    }

    if (req.method === "POST" && pathname === "/api/start") {
      const body = await parseJson(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      startRoom(room);
      return sendJson(res, 200, { state: publicState(room) });
    }

    if (req.method === "POST" && pathname === "/api/vote") {
      const body = await parseJson(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      ensureExpired(room);
      if (!room.started) return sendJson(res, 409, { error: "room not started" });
      if (room.ended) return sendJson(res, 409, { error: "room ended" });
      const toolId = Number(body.toolId);
      const voterId = String(body.voterId || "");
      if (!toolId || !voterId) return sendJson(res, 400, { error: "voterId and toolId are required" });
      const previous = room.ballots[voterId];
      if (previous === toolId) {
        return sendJson(res, 200, { state: publicState(room) });
      }
      if (previous && room.votes[previous] > 0) {
        room.votes[previous] -= 1;
      }
      room.ballots[voterId] = toolId;
      room.votes[toolId] = (room.votes[toolId] || 0) + 1;
      room.touchAt[toolId] = now();
      room.updatedAt = now();
      lastRoomId = room.roomId;
      persistRooms();
      broadcast(room);
      return sendJson(res, 200, { state: publicState(room) });
    }

    if (req.method === "POST" && pathname === "/api/reset") {
      const body = await parseJson(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      resetRoom(room, Number(body.durationMs) || 60 * 1000);
      return sendJson(res, 200, { state: publicState(room) });
    }

    if (req.method === "POST" && pathname === "/api/end") {
      const body = await parseJson(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      endRoom(room);
      return sendJson(res, 200, { state: publicState(room) });
    }

    if (req.method === "POST" && pathname === "/api/confirm") {
      const body = await parseJson(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: "room not found" });
      room.confirmedAt = now();
      room.confirmedOrder = ranking(room).map((tool) => tool.id);
      room.updatedAt = now();
      lastRoomId = room.roomId;
      persistRooms();
      broadcast(room);
      return sendJson(res, 200, { state: publicState(room) });
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
      if (req.method === "HEAD") return serveIndexHead(res);
      return serveIndex(res);
    }

    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/index.html") {
      if (req.method === "HEAD") return serveIndexHead(res);
      return serveIndex(res);
    }

    if (req.method === "GET") {
      return serveIndex(res);
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "Internal error" }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const localIp = getLocalIp();
  console.log(`Live vote server running at http://127.0.0.1:${PORT}`);
  if (localIp && localIp !== "127.0.0.1") {
    console.log(`LAN access: http://${localIp}:${PORT}`);
  }
});
