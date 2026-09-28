const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "../../..");

const DEV_API_PORT = 8080;
const DEV_WEB_PORT = 5173;

let apiProcess = null;
let viteProcess = null;
let staticServer = null;
let mainWindow = null;
let productionApiPort = null;

function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);

    server.listen(0, host, () => {
      const port = server.address().port;

      server.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();

    function retry() {
      if (Date.now() - started > timeout) {
        reject(new Error(`Server did not start: ${url}`));
        return;
      }

      setTimeout(check, 300);
    }

    function check() {
      const req = http.get(url, (res) => {
        res.resume();

        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });

      req.on("error", retry);

      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    }

    check();
  });
}

function startDevelopmentApi() {
  console.log("Starting API server...");

  const apiDir = path.join(ROOT, "artifacts/api-server");

  apiProcess = spawn("pnpm", ["run", "dev"], {
    cwd: apiDir,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(DEV_API_PORT),
    },
    stdio: "inherit",
    shell: false,
  });

  apiProcess.on("error", (err) => {
    console.error("API process error:", err);
  });
}

function startDevelopmentVite() {
  console.log("Starting dashboard...");

  const dashboardDir = path.join(
    ROOT,
    "artifacts/github-automation-dashboard",
  );

  const viteBin = path.join(
    dashboardDir,
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );

  viteProcess = spawn(
    "node",
    [
      viteBin,
      "--config",
      "vite.config.ts",
      "--host",
      "0.0.0.0",
      "--port",
      String(DEV_WEB_PORT),
    ],
    {
      cwd: dashboardDir,
      env: {
        ...process.env,
        WEB_PORT: String(DEV_WEB_PORT),
        API_URL: `http://localhost:${DEV_API_PORT}`,
      },
      stdio: "inherit",
    },
  );

  viteProcess.on("error", (err) => {
    console.error("Vite process error:", err);
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };

  return types[ext] || "application/octet-stream";
}

function startProductionApi() {
  return new Promise(async (resolve, reject) => {
    try {
      productionApiPort = await findFreePort();

      process.env.NODE_ENV = "production";
      process.env.PORT = String(productionApiPort);

      const backendPath = path.join(
        process.resourcesPath,
        "backend",
        "index.mjs",
      );

      if (!fs.existsSync(backendPath)) {
        throw new Error(`Bundled API not found: ${backendPath}`);
      }

      console.log(`Starting bundled API on port ${productionApiPort}...`);

      await import(
        `${pathToFileURL(backendPath).href}?electron=${Date.now()}`
      );

      await waitForServer(
        `http://127.0.0.1:${productionApiPort}/`,
        30000,
      );

      console.log("Bundled API started.");

      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

function startProductionStaticServer() {
  return new Promise(async (resolve, reject) => {
    try {
      const dashboardPath = path.join(
        process.resourcesPath,
        "dashboard",
      );

      const indexPath = path.join(dashboardPath, "index.html");

      if (!fs.existsSync(indexPath)) {
        throw new Error(`Dashboard not found: ${indexPath}`);
      }

      const port = await findFreePort();

      staticServer = http.createServer((req, res) => {
        const requestUrl = new URL(
          req.url || "/",
          `http://127.0.0.1:${port}`,
        );

        // API proxy
        if (requestUrl.pathname.startsWith("/api/")) {
          const proxy = http.request(
            {
              hostname: "127.0.0.1",
              port: productionApiPort,
              path:
                requestUrl.pathname +
                requestUrl.search,
              method: req.method,
              headers: {
                ...req.headers,
                host: `127.0.0.1:${productionApiPort}`,
              },
            },
            (proxyRes) => {
              res.writeHead(
                proxyRes.statusCode || 502,
                proxyRes.headers,
              );

              proxyRes.pipe(res);
            },
          );

          proxy.on("error", (error) => {
            console.error("API proxy error:", error);
            res.writeHead(502);
            res.end("API unavailable");
          });

          req.pipe(proxy);
          return;
        }

        let relativePath = decodeURIComponent(
          requestUrl.pathname,
        );

        if (relativePath === "/") {
          relativePath = "/index.html";
        }

        const safePath = path.normalize(
          path.join(dashboardPath, relativePath),
        );

        if (!safePath.startsWith(path.normalize(dashboardPath))) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }

        if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
          // SPA fallback
          const fallback = indexPath;

          if (fs.existsSync(fallback)) {
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
            });

            fs.createReadStream(fallback).pipe(res);
            return;
          }

          res.writeHead(404);
          res.end("Not found");
          return;
        }

        res.writeHead(200, {
          "Content-Type": getMimeType(safePath),
        });

        fs.createReadStream(safePath).pipe(res);
      });

      staticServer.listen(port, "127.0.0.1", () => {
        console.log(`Bundled dashboard on port ${port}`);
        resolve(port);
      });

      staticServer.on("error", reject);
    } catch (error) {
      reject(error);
    }
  });
}

async function createDevelopmentWindow() {
  startDevelopmentApi();

  await waitForServer(
    `http://127.0.0.1:${DEV_API_PORT}/`,
  );

  startDevelopmentVite();

  await waitForServer(
    `http://127.0.0.1:${DEV_WEB_PORT}/`,
  );

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "GitHub Automation Dashboard",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(
    `http://localhost:${DEV_WEB_PORT}`,
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function createProductionWindow() {
  await startProductionApi();

  const webPort = await startProductionStaticServer();

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: "GitHub Automation Dashboard",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(
    `http://127.0.0.1:${webPort}`,
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function killProcess(child) {
  if (!child || child.killed) return;

  try {
    child.kill("SIGTERM");
  } catch {}
}

function shutdown() {
  console.log("Stopping application...");

  killProcess(viteProcess);
  killProcess(apiProcess);

  viteProcess = null;
  apiProcess = null;

  if (staticServer) {
    try {
      staticServer.close();
    } catch {}

    staticServer = null;
  }
}

app.whenReady().then(async () => {
  try {
    if (app.isPackaged) {
      await createProductionWindow();
    } else {
      await createDevelopmentWindow();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const task = app.isPackaged
          ? createProductionWindow()
          : createDevelopmentWindow();

        task.catch(console.error);
      }
    });
  } catch (error) {
    console.error("Failed to start application:", error);
    shutdown();
    app.quit();
  }
});

app.on("before-quit", () => {
  shutdown();
});

app.on("window-all-closed", () => {
  shutdown();

  if (process.platform !== "darwin") {
    app.quit();
  }
});
