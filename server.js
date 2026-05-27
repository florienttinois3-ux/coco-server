/**
 * J.A.R.V.I.S — Serveur de Localisation
 * ─────────────────────────────────────────
 * Un seul process, un seul port.
 *  HTTP  → sert /pc  et /mobile (fichiers statiques)
 *  HTTP  → /qr.png  génère le QR code à la volée
 *  HTTP  → /api/*   config JSON (adresse serveur)
 *  WS    → relais GPS  téléphone ──► PC
 *
 * Déployable tel quel sur Render (Free tier).
 * Variable d'environnement : PORT (Render la fournit automatiquement)
 */

"use strict";

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const os      = require("os");
const { WebSocketServer } = require("ws");
const QRCode  = require("qrcode");

// ── Constantes ─────────────────────────────────────────────────────────────
const PORT    = parseInt(process.env.PORT || "8080", 10);
const PUBLIC  = path.join(__dirname, "../public");
const CFG     = path.join(__dirname, "config.json");

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

// ── IP locale (LAN) ────────────────────────────────────────────────────────
function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === "IPv4" && !i.internal) return i.address;
  return "127.0.0.1";
}
const LOCAL_IP   = localIP();
const LOCAL_BASE = `http://${LOCAL_IP}:${PORT}`;

// ── Config persistante (adresse serveur personnalisable) ───────────────────
let config = { serverAddress: "" };   // vide = on utilise l'adresse locale auto
try { Object.assign(config, JSON.parse(fs.readFileSync(CFG, "utf8"))); } catch {}

function effectiveBase() {
  const addr = (config.serverAddress || "").trim().replace(/\/$/, "");
  return addr || LOCAL_BASE;
}
function mobileURL() { return effectiveBase() + "/mobile"; }
function saveConfig() {
  try { fs.writeFileSync(CFG, JSON.stringify(config, null, 2)); } catch {}
}

// ── État global ────────────────────────────────────────────────────────────
const pcSet    = new Set();   // clients WebSocket rôle PC
const phoneSet = new Set();   // clients WebSocket rôle téléphone
let   lastGPS  = null;        // dernière position reçue

// ── Broadcast helpers ──────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(clients, obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

// ── Body reader ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => { buf += c; if (buf.length > 1e5) reject(new Error("too large")); });
    req.on("end",  () => resolve(buf));
    req.on("error", reject);
  });
}

// ── Serveur HTTP ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const rawURL = req.url || "/";
  const url    = rawURL.split("?")[0];
  const method = req.method.toUpperCase();

  // ── CORS léger pour dev ────────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ── QR code ────────────────────────────────────────────────────────────
  if (url === "/qr" || url === "/qr.png") {
    try {
      const buf = await QRCode.toBuffer(mobileURL(), {
        width : 320,
        margin: 2,
        color : { dark: "#4ca8e8", light: "#050508" },
      });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache, no-store" });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500); return res.end("QR error: " + e.message);
    }
  }

  // ── API : GET info ─────────────────────────────────────────────────────
  if (url === "/api/info" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      localIP      : LOCAL_IP,
      port         : PORT,
      serverAddress: config.serverAddress,
      effectiveBase: effectiveBase(),
      mobileURL    : mobileURL(),
      pcCount      : pcSet.size,
      phoneCount   : phoneSet.size,
      lastGPS,
    }));
  }

  // ── API : POST config (sauvegarde adresse serveur) ─────────────────────
  if (url === "/api/config" && method === "POST") {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      if (typeof data.serverAddress === "string") {
        config.serverAddress = data.serverAddress.trim().replace(/\/$/, "");
        saveConfig();
        const info = { type: "config_updated", serverAddress: config.serverAddress, mobileURL: mobileURL() };
        broadcast(pcSet,    info);
        broadcast(phoneSet, info);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, mobileURL: mobileURL(), effectiveBase: effectiveBase() }));
    } catch (e) {
      res.writeHead(400); return res.end("Bad request: " + e.message);
    }
  }

  // ── Fichiers statiques ─────────────────────────────────────────────────
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
    filePath = path.join(PUBLIC, url);   // orb.js, etc.

  // Sécurité traversal
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

// ── Serveur WebSocket ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const qs   = new URLSearchParams((req.url || "").replace(/^[^?]*\??/, ""));
  const role = qs.get("role");   // "pc" | "phone"

  // ──────────────────────────────────────────────
  // Rôle TÉLÉPHONE
  // ──────────────────────────────────────────────
  if (role === "phone") {
    phoneSet.add(ws);
    console.log(`[WS] 📱 Téléphone connecté  (total: ${phoneSet.size})`);

    // Envoyer la config actuelle au téléphone dès la connexion
    send(ws, {
      type         : "server_info",
      serverAddress: config.serverAddress,
      mobileURL    : mobileURL(),
    });

    // Notifier les PCs
    broadcast(pcSet, { type: "phone_connected", count: phoneSet.size });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);

        // Position GPS → sauvegarder + relayer aux PCs
        if (msg.type === "gps") {
          lastGPS = { ...msg, receivedAt: Date.now() };
          broadcast(pcSet, { type: "gps", ...msg });
        }

        // Ping-pong keepalive
        if (msg.type === "ping") {
          send(ws, { type: "pong" });
        }

      } catch { /* JSON invalide, ignorer */ }
    });

    ws.on("close", () => {
      phoneSet.delete(ws);
      console.log(`[WS] 📱 Téléphone déconnecté (restants: ${phoneSet.size})`);
      broadcast(pcSet, { type: "phone_disconnected", count: phoneSet.size });
    });

    ws.on("error", err => console.warn("[WS] phone error:", err.message));
    return;
  }

  // ──────────────────────────────────────────────
  // Rôle PC (défaut)
  // ──────────────────────────────────────────────
  pcSet.add(ws);
  console.log(`[WS] 🖥️  PC connecté          (total: ${pcSet.size})`);

  // Envoyer l'état courant immédiatement
  send(ws, {
    type         : "server_info",
    localIP      : LOCAL_IP,
    port         : PORT,
    serverAddress: config.serverAddress,
    effectiveBase: effectiveBase(),
    mobileURL    : mobileURL(),
    phoneCount   : phoneSet.size,
    lastGPS,
  });

  ws.on("close", () => {
    pcSet.delete(ws);
    console.log(`[WS] 🖥️  PC déconnecté`);
  });

  ws.on("error", err => console.warn("[WS] pc error:", err.message));
});

// ── Démarrage ──────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  const line = "═".repeat(62);
  console.log();
  console.log(line);
  console.log("   J.A.R.V.I.S — Serveur Localisation");
  console.log(line);
  console.log(`  Interface PC     →  ${LOCAL_BASE}/pc`);
  console.log(`  Interface Mobile →  ${mobileURL()}`);
  console.log(`  QR Code          →  ${LOCAL_BASE}/qr`);
  console.log(`  WebSocket        →  ws://${LOCAL_IP}:${PORT}`);
  if (config.serverAddress)
    console.log(`  Adresse custom   →  ${config.serverAddress}`);
  console.log(line);
  console.log();
});
