#!/usr/bin/env node
// Serve the web app on this computer: npm start [-- --port 8010] [--host 0.0.0.0] [--no-browser]
//
// The page is static and the analysis runs in the browser; a server is only needed because
// browsers refuse JavaScript modules and workers from file:// pages.

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const APP = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8000" },
    "no-browser": { type: "boolean", default: false },
  },
});

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  let file = normalize(join(APP, path));
  if (file !== APP && !file.startsWith(APP + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(file).pipe(response);
});

server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE"
    ? `Port ${values.port} is already used by another program: start with --port 8010.`
    : error.message);
  process.exit(1);
});

server.listen(Number(values.port), values.host, () => {
  const url = `http://${values.host}:${values.port}`;
  console.log(`Betaflight auto-tune on ${url} (Ctrl+C to stop)`);
  if (!values["no-browser"]) {
    const [command, ...args] = process.platform === "win32" ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
});
