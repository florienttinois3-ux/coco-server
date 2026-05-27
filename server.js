/**
 * COCO — Serveur de Localisation
 * ─────────────────────────────────────────
 * Tourne sur Render : https://coco-connect.onrender.com
 *  HTTP  → sert /pc  et /mobile (fichiers statiques)
 *  HTTP  → /qr.png  génère le QR code
 *  HTTP  → /api/info
 *  WS    → relais GPS  téléphone ──► PC
 */

"use strict";

const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

// ── Constantes ──────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT || "8080", 10);
const BASE_URL   = "https://coco-connect.onrender.com";
const MOBILE_URL = BASE_URL + "/mobile";
const PUBLIC     = path.join(__dirname, "public");

const MIME = {
  ".html" : "text/html; charset=utf-8",
  ".js"   : "application/javascript",
  ".css"  : "text/css",
  ".png"  : "image/png",
  ".ico"  : "image/x-icon",
  ".json" : "application/json",
  ".svg"  : "image/svg+xml",
  ".woff2": "font/woff2",
};

// ── État global ──────────────────────────────────────────────────────────────
const pcSet    = new Set();
const phoneSet = new Set();
let   lastGPS  = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(clients, obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 1e5) reject(new Error("too large")); });
    req.on("end",  () => resolve(buf));
    req.on("error", reject);
  });
}

// ── Serveur HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = (req.url || "/").split("?")[0];
  const method = req.method.toUpperCase();

  res.setHeader("Access-Control-Allow-Origin", "*");

  // QR code
  if (url === "/qr" || url === "/qr.png") {
    try {
      const buf = await QRCode.toBuffer(MOBILE_URL, {
        width: 320, margin: 2,
        color: { dark: "#4ca8e8", light: "#050508" },
      });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache, no-store" });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500); return res.end("QR error: " + e.message);
    }
  }

  // API info
  if (url === "/api/info" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      serverAddress: BASE_URL,
      mobileURL    : MOBILE_URL,
      pcCount      : pcSet.size,
      phoneCount   : phoneSet.size,
      lastGPS,
    }));
  }

  // Fichiers statiques
  let filePath;
  if (url === "/" || url === "/pc" || url === "/pc/")
    filePath = path.join(PUBLIC, "pc/index.html");
  else if (url.startsWith("/pc/"))
    filePath = path.join(PUBLIC, "pc", url.slice(4));
  else if (url === "/mobile" || url === "/mobile/")
    filePath = path.join(PUBLIC, "mobile/index.html");
  else if (url.startsWith("/mobile/"))
    filePath = path.join(PUBLIC, "mobile", url.slice(8));
  else
    filePath = path.join(PUBLIC, url);

  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("404 Not Found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const qs   = new URLSearchParams((req.url || "").replace(/^[^?]*\??/, ""));
  const role = qs.get("role");

  // TÉLÉPHONE
  if (role === "phone") {
    phoneSet.add(ws);
    console.log(`[WS] 📱 Téléphone connecté  (total: ${phoneSet.size})`);

    send(ws, { type: "server_info", serverAddress: BASE_URL, mobileURL: MOBILE_URL });
    broadcast(pcSet, { type: "phone_connected", count: phoneSet.size });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "gps") {
          lastGPS = { ...msg, receivedAt: Date.now() };
          broadcast(pcSet, { type: "gps", ...msg });
        }
        if (msg.type === "ping") send(ws, { type: "pong" });
      } catch {}
    });

    ws.on("close", () => {
      phoneSet.delete(ws);
      console.log(`[WS] 📱 Téléphone déconnecté (restants: ${phoneSet.size})`);
      broadcast(pcSet, { type: "phone_disconnected", count: phoneSet.size });
    });

    ws.on("error", err => console.warn("[WS] phone error:", err.message));
    return;
  }

  // PC
  pcSet.add(ws);
  console.log(`[WS] 🖥️  PC connecté  (total: ${pcSet.size})`);

  send(ws, {
    type         : "server_info",
    serverAddress: BASE_URL,
    mobileURL    : MOBILE_URL,
    phoneCount   : phoneSet.size,
    lastGPS,
  });

  ws.on("close", () => {
    pcSet.delete(ws);
    console.log(`[WS] 🖥️  PC déconnecté`);
  });

  ws.on("error", err => console.warn("[WS] pc error:", err.message));
});

// ── Démarrage ─────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`   COCO — Serveur Localisation`);
  console.log(`${"═".repeat(50)}`);
  console.log(`  PC     →  ${BASE_URL}/pc`);
  console.log(`  Mobile →  ${MOBILE_URL}`);
  console.log(`  QR     →  ${BASE_URL}/qr`);
  console.log(`  WS     →  wss://coco-connect.onrender.com`);
  console.log(`${"═".repeat(50)}\n`);
});
