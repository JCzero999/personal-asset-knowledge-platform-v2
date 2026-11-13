/**
 * Phase 5 验收脚本：无头 Chrome（CDP）截图与运行时读数（ADR-020）。
 *
 * 用途：
 *   node scripts/phase5-capture.mjs poster      # 生成 public/galaxy 静态图
 *   node scripts/phase5-capture.mjs shots       # 生成 docs/screenshots/phase5-*
 *   node scripts/phase5-capture.mjs probe       # 首页性能/降级读数（JSON）
 *
 * 依赖：本机 Chrome + ffmpeg（仅 poster 需要 ffmpeg 转 JPG）。
 * 不引入 puppeteer，直接用 Node 24 自带的 WebSocket 走 CDP。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const ROOT = path.resolve(import.meta.dirname, "..");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/** 截图文件名前缀与主题（Phase 5b 增加多主题验收）。 */
const SHOT_PREFIX = process.env.SHOT_PREFIX || "phase5";
const SHOT_THEME = process.env.SHOT_THEME || "galaxy";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      const key = `${message.sessionId ?? ""}:${message.method}`;
      for (const fn of this.listeners.get(key) ?? []) fn(message.params);
      for (const fn of this.listeners.get(message.method) ?? []) fn(message.params, message.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method}: timeout`));
        }
      }, 60000);
    });
  }

  on(event, fn) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
}

async function waitForEndpoint(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // Chrome 还没起来
    }
    await sleep(150);
  }
  throw new Error(`Chrome 调试端口 ${url} 未就绪`);
}

async function launchBrowser(extraArgs = []) {
  if (!CHROME) throw new Error("找不到 Chrome，可用 CHROME_PATH 指定");
  const userDataDir = path.join(os.tmpdir(), `phase5-chrome-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--window-size=1920,1080",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const version = await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const cdp = new Cdp(ws);

  return {
    cdp,
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch {
        child.kill();
      }
      ws.close();
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** 开一个新页面（独立 target），返回 page 句柄。 */
async function openPage(cdp, options = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    sessionId,
    consoleErrors: [],
    pageErrors: [],
    send: (method, params) => cdp.send(method, params, sessionId),
    async evaluate(expression) {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本执行失败");
      }
      return result.result?.value;
    },
    async goto(url) {
      const loaded = new Promise((resolve) => {
        cdp.on(`${sessionId}:Page.loadEventFired`, resolve);
        setTimeout(resolve, 15000);
      });
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
    },
    async waitFor(expression, timeoutMs = 20000, intervalMs = 120) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          if (await page.evaluate(expression)) return true;
        } catch {
          // 页面还在导航/重建
        }
        await sleep(intervalMs);
      }
      return false;
    },
    async setViewport({ width, height, dpr = 1, mobile = false }) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile,
        screenWidth: width,
        screenHeight: height,
      });
    },
    async setReducedMotion(enabled) {
      await page.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: enabled ? "reduce" : "no-preference" }],
      });
    },
    /**
     * 导航前写入 localStorage，模拟用户上次选过的主题（跨刷新保持）。
     * 返回脚本 id：只想预置首屏时，加载后要 removePrimedTheme 掉，
     * 否则它会盖掉页面自己写入的新主题。
     */
    async primeTheme(theme) {
      const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `try { localStorage.setItem("pakp.theme", ${JSON.stringify(theme)}); } catch (error) {}`,
      });
      return identifier;
    },
    async removePrimedTheme(identifier) {
      if (!identifier) return;
      await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
    },
    async screenshot(file) {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true,
      });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"));
      return file;
    },
    /** 真实鼠标点击：React 的 onClick 走指针事件，element.click() 不够稳。 */
    async clickSelector(selector, textPattern) {
      const point = await page.evaluate(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const matcher = ${JSON.stringify(textPattern ?? null)};
        const node = matcher
          ? nodes.find((item) => new RegExp(matcher).test(item.textContent || ""))
          : nodes[0];
        if (!node) return null;
        node.scrollIntoView({ block: "center" });
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);

      if (!point) return false;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
      }
      return true;
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  cdp.on(`${sessionId}:Runtime.consoleAPICalled`, (params) => {
    if (params.type !== "error") return;
    page.consoleErrors.push(
      params.args.map((arg) => arg.description ?? arg.value ?? "").join(" ").slice(0, 600),
    );
  });
  cdp.on(`${sessionId}:Runtime.exceptionThrown`, (params) => {
    page.pageErrors.push(params.exceptionDetails?.exception?.description?.slice(0, 600) ?? "exception");
  });

  return page;
}

async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: "ignore", windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
}

/* ============================================================
   poster：用我们自己的场景渲染静态图
   ============================================================ */
async function poster(browser) {
  const cases = [
    {
      name: "desktop",
      file: path.join(ROOT, "public/galaxy/galaxy-1920x1080.jpg"),
      viewport: { width: 1920, height: 1080, dpr: 1 },
      quality: [4, 6],
    },
    {
      name: "mobile",
      file: path.join(ROOT, "public/galaxy/galaxy-1170x2532.jpg"),
      viewport: { width: 585, height: 1266, dpr: 2, mobile: true },
      quality: [3, 5],
    },
  ];

  await mkdir(path.join(ROOT, "public/galaxy"), { recursive: true });

  for (const item of cases) {
    const page = await openPage(browser.cdp);
    await page.setViewport({ ...item.viewport, dpr: item.viewport.dpr ?? 1 });
    await page.goto(`${BASE}/galaxy/poster`);
    const ready = await page.waitFor("window.__galaxyPosterReady === true", 25000);
    if (!ready) throw new Error(`${item.name}: 场景没有在 25s 内渲染完成`);
    await sleep(250);

    const png = path.join(os.tmpdir(), `phase5-poster-${item.name}.png`);
    await page.screenshot(png);

    let chosen = null;
    for (const q of item.quality) {
      await runFfmpeg(["-y", "-i", png, "-q:v", String(q), "-pix_fmt", "yuv420p", item.file]);
      const info = await stat(item.file);
      chosen = { q, bytes: info.size };
      if (info.size <= 400 * 1024) break;
    }

    const info = await stat(item.file);
    console.log(
      `[poster] ${item.name}: ${path.relative(ROOT, item.file)} ${(info.size / 1024).toFixed(0)}KB (q:v ${chosen.q})`,
    );
    if (info.size > 400 * 1024) throw new Error(`${item.name} 静态图超过 400KB`);

    const stats = await page.evaluate("window.__galaxyStats");
    console.log(`[poster] ${item.name} stats`, JSON.stringify(stats));
    await page.close();
  }
}

/* ============================================================
   probe：首页性能与降级读数
   ============================================================ */
async function probe(browser, options = {}) {
  const results = {};
  const page = await openPage(browser.cdp);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/`);
  await page.waitFor("window.__galaxyStats && window.__galaxyStats.mode === 'webgl'", 25000);
  await sleep(1500);

  results.desktop = await page.evaluate(`(() => {
    const stats = window.__galaxyStats;
    return {
      ...stats,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      bodyOverflowY: document.documentElement.scrollHeight > window.innerHeight,
      webglRenderer: (() => {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        if (!gl) return null;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
      })(),
    };
  })()`);

  // 页面隐藏 → rAF 应停止。
  // 注意 `window.__galaxyStats.frames` 是每 30 帧发布一次的快照，
  // 隐藏时处理器会 publish 一次把真实帧数写进去，所以要在隐藏后
  // 先读一次让快照对齐，再等待，比较“等待期间”是否还在增长。
  await page.evaluate(`(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
  const atHide = await page.evaluate("window.__galaxyStats.frames");
  await sleep(700);
  const afterHide = await page.evaluate("window.__galaxyStats.frames");
  results.visibility = {
    framesAtHide: atHide,
    framesAfter700ms: afterHide,
    rafActive: await page.evaluate("window.__galaxyStats.rafActive"),
    paused: await page.evaluate("window.__galaxyStats.paused"),
    grewWhileHidden: afterHide > atHide,
  };
  await page.close();

  if (!options.skipVariants) {
    // 移动端
    const mobile = await openPage(browser.cdp);
    await mobile.setViewport({ width: 390, height: 844, dpr: 3, mobile: true });
    await mobile.goto(`${BASE}/`);
    await mobile.waitFor("window.__galaxyStats && window.__galaxyStats.mode === 'webgl'", 25000);
    await sleep(1200);
    results.mobile = await mobile.evaluate(`(() => {
      const stats = window.__galaxyStats;
      return {
        ...stats,
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
      };
    })()`);
    await mobile.close();

    // reduced motion：零 rAF。
    // 计数脚本要在导航前注入（addScriptToEvaluateOnNewDocument），
    // 否则 evaluate 装上的钩子会随页面重建丢失。
    const still = await openPage(browser.cdp);
    await still.setReducedMotion(true);
    await still.setViewport({ width: 1440, height: 900, dpr: 1 });
    await still.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__rafCalls = 0;
        const original = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => { window.__rafCalls += 1; return original(callback); };
      })();`,
    });
    await still.goto(`${BASE}/`);
    await sleep(1800);
    results.reducedMotion = await still.evaluate(`({
      stats: window.__galaxyStats,
      rafCalls: window.__rafCalls,
      posterVisible: (() => {
        const image = document.querySelector(".galaxy-poster img");
        return Boolean(image && image.complete && image.naturalWidth > 0);
      })(),
    })`);
    await still.close();

    // 禁用 WebGL：降级到自渲染静态图（poster），零 rAF。
    const noGl = await openPage(browser.cdp);
    await noGl.setViewport({ width: 1440, height: 900, dpr: 1 });
    await noGl.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          if (typeof type === "string" && type.includes("webgl")) return null;
          return original.call(this, type, ...rest);
        };
      })();`,
    });
    await noGl.goto(`${BASE}/`);
    await sleep(1600);
    results.webglDisabled = await noGl.evaluate(`(() => {
      const poster = document.querySelector(".galaxy-poster img");
      const stars = document.querySelector(".galaxy-fallback-stars");
      const canvas = document.querySelector(".galaxy-canvas");
      return {
        stats: window.__galaxyStats,
        posterVisible: Boolean(poster && poster.complete && poster.naturalWidth > 0),
        posterNaturalSize: poster ? [poster.naturalWidth, poster.naturalHeight] : null,
        starsDisplay: stars ? getComputedStyle(stars).display : null,
        canvasOpacity: canvas ? getComputedStyle(canvas).opacity : null,
      };
    })()`);
    await noGl.screenshot(path.join(ROOT, "docs/screenshots/phase5-home-no-webgl.png")).catch(() => {});
    await noGl.close();
  }

  return results;
}

/* ============================================================
   shots：整站关键页面截图
   ============================================================ */
const SHOT_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, dpr: 1 },
  { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
];

const SHOT_PAGES = [
  {
    slug: "home",
    url: "/",
    wait: "window.__galaxyStats && window.__galaxyStats.mode === 'webgl'",
    settle: 1600,
  },
  {
    slug: "home-static",
    url: "/?still=1",
    reducedMotion: true,
    wait: "window.__galaxyStats && window.__galaxyStats.mode === 'poster'",
    settle: 900,
    desktopOnly: true,
  },
  {
    slug: "drawer",
    url: "/?still=1",
    reducedMotion: true,
    wait: "document.querySelector('.galaxy-handle')",
    prepare: async (page) => {
      await page.clickSelector(".galaxy-handle");
      await sleep(480);
    },
    mobileOnly: true,
  },
  {
    slug: "login",
    url: "/",
    base: "UNAUTH",
    wait: "document.querySelector('.galaxy-enter')",
    settle: 900,
    desktopOnly: true,
  },
  { slug: "workspace", url: "/workspace", wait: "document.querySelector('.record-rows')", settle: 900 },
  {
    slug: "detail",
    url: "/workspace",
    wait: "document.querySelector('.record-row')",
    prepare: async (page) => {
      await page.clickSelector(".record-row");
      await sleep(900);
    },
    desktopOnly: true,
  },
  {
    slug: "editor",
    url: "/workspace",
    wait: "document.querySelector('.record-row')",
    prepare: async (page) => {
      await page.clickSelector(".record-row");
      await sleep(900);
      await page.clickSelector("button", "编写正文|编辑正文");
      await sleep(1200);
    },
    desktopOnly: true,
  },
  { slug: "search", url: "/search?q=%E5%86%85%E5%AE%B9", wait: "document.querySelector('.search-page, main')", settle: 900 },
  { slug: "graph", url: "/graph", wait: "document.querySelector('.graph-page, main')", settle: 1400 },
  { slug: "admin", url: "/admin", wait: "document.querySelector('.admin-shell, main')", settle: 900, desktopOnly: true },
];

async function shots(browser) {
  const outDir = path.join(ROOT, "docs/screenshots");
  await mkdir(outDir, { recursive: true });
  const unauthBase = process.env.BASE_UNAUTH || BASE;
  const problems = [];
  const only = (process.env.SHOT_ONLY || "").split(",").filter(Boolean);

  for (const pageSpec of SHOT_PAGES) {
    if (only.length && !only.includes(pageSpec.slug)) continue;
    for (const viewport of SHOT_VIEWPORTS) {
      if (pageSpec.desktopOnly && viewport.name === "mobile") continue;
      if (pageSpec.mobileOnly && viewport.name === "desktop") continue;

      const page = await openPage(browser.cdp);
      await page.setViewport(viewport);
      if (pageSpec.reducedMotion) await page.setReducedMotion(true);
      // 首页固定深空，其他页面按当前验收主题渲染。
      if (pageSpec.themeAware !== false) await page.primeTheme(SHOT_THEME);

      const origin = pageSpec.base === "UNAUTH" ? unauthBase : BASE;
      await page.goto(`${origin}${pageSpec.url}`);
      await page.waitFor(pageSpec.wait, 20000).catch(() => false);

      if (pageSpec.prepare) await pageSpec.prepare(page).catch(() => {});
      await sleep(pageSpec.settle ?? 700);

      if (process.env.DEBUG_POINT) {
        const [x, y] = process.env.DEBUG_POINT.split(",").map(Number);
        const hits = await page.evaluate(
          `document.elementsFromPoint(${x}, ${y}).map((el) => el.tagName + "." + el.className).slice(0, 6)`,
        );
        console.log("  debug:", JSON.stringify(hits));
      }

      if (process.env.DEBUG_DOM) {
        const dump = await page.evaluate(`(() => {
          const textNodes = [...document.querySelectorAll("*")]
            .filter((el) => el.children.length === 0 && /搜索资产/.test(el.textContent || ""))
            .map((el) => {
              const rect = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              return {
                tag: el.tagName,
                cls: el.className,
                rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
                color: style.color,
                filter: style.filter,
                opacity: style.opacity,
                transform: style.transform,
              };
            });
          return textNodes;
        })()`);
        console.log("  dom:", JSON.stringify(dump, null, 1));
      }

      const file = path.join(
        outDir,
        `${SHOT_PREFIX}-${pageSpec.slug}-${SHOT_THEME}-${viewport.name}.png`,
      );
      await page.screenshot(file);
      console.log(`[shot] ${path.relative(ROOT, file)}`);

      if (page.consoleErrors.length || page.pageErrors.length) {
        const entry = `${pageSpec.slug}-${viewport.name}: ${JSON.stringify([
          ...page.consoleErrors,
          ...page.pageErrors,
        ])}`;
        problems.push(entry);
        console.log(`  console: ${entry}`);
      }

      // 横向溢出检查：任何一页都不该出现横向滚动条。
      if (viewport.name === "mobile") {
        const overflow = await page.evaluate(
          "document.documentElement.scrollWidth - document.documentElement.clientWidth",
        ).catch(() => 0);
        if (overflow > 1) {
          problems.push(`${pageSpec.slug}-mobile 横向溢出 ${overflow}px`);
          console.log(`  overflow: ${pageSpec.slug}-mobile ${overflow}px`);
        }
      }

      await page.close();
    }
  }

  console.log(problems.length ? `[shots] ${problems.length} 个问题` : "[shots] 无 console 错误、无横向溢出");
  return problems;
}

/* ============================================================
   measure：首页构图实测（搜索框 / 星系中心的视口百分比）
   ============================================================ */

/** 跑一个命令并把 stdout 收成 Buffer。 */
function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${command} 退出码 ${code}`)),
    );
  });
}

async function imageSize(file) {
  const out = (await runCapture("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
    file,
  ])).toString().trim();
  const [width, height] = out.split(",").map(Number);
  return { width, height };
}

/**
 * 按亮度加权求质心，用来实测「星系实际画在哪里」。
 * 深空底接近纯黑，阈值为 24 时只剩星点与星云，文字像素占比很小。
 */
async function imageCentroid(file) {
  const { width, height } = await imageSize(file);
  const scale = Math.min(1, 360 / width);
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const raw = await runCapture(FFMPEG, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `scale=${sampleWidth}:${sampleHeight},format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);

  let weightSum = 0;
  let xSum = 0;
  let ySum = 0;
  let count = 0;
  let minX = sampleWidth;
  let maxX = 0;
  let minY = sampleHeight;
  let maxY = 0;

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const value = raw[y * sampleWidth + x];
      if (value < 24) continue;
      const weight = value - 24;
      weightSum += weight;
      xSum += x * weight;
      ySum += y * weight;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // 页面文字也会被计入亮度，再做一次强模糊 + 高阈值，只保留核球亮斑。
  const blurred = await runCapture(FFMPEG, [
    "-v",
    "error",
    "-i",
    file,
    "-vf",
    `scale=${sampleWidth}:${sampleHeight},gblur=sigma=8,format=gray`,
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-",
  ]);
  let peak = 0;
  for (const value of blurred) {
    if (value > peak) peak = value;
  }
  let coreWeight = 0;
  let coreX = 0;
  let coreY = 0;
  const coreThreshold = peak * 0.92;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const value = blurred[y * sampleWidth + x];
      if (value < coreThreshold) continue;
      const weight = value - coreThreshold;
      coreWeight += weight;
      coreX += x * weight;
      coreY += y * weight;
    }
  }

  return {
    centerXPct: weightSum ? (xSum / weightSum / sampleWidth) * 100 : null,
    centerYPct: weightSum ? (ySum / weightSum / sampleHeight) * 100 : null,
    coreXPct: coreWeight ? +(coreX / coreWeight / sampleWidth * 100).toFixed(1) : null,
    coreYPct: coreWeight ? +(coreY / coreWeight / sampleHeight * 100).toFixed(1) : null,
    brightCoveragePct: ((count / (sampleWidth * sampleHeight)) * 100).toFixed(2),
    brightBoxPct: count
      ? {
          left: ((minX / sampleWidth) * 100).toFixed(1),
          right: ((maxX / sampleWidth) * 100).toFixed(1),
          top: ((minY / sampleHeight) * 100).toFixed(1),
          bottom: ((maxY / sampleHeight) * 100).toFixed(1),
        }
      : null,
  };
}

const HOME_METRICS = `(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      top: +rect.top.toFixed(1),
      bottom: +rect.bottom.toFixed(1),
      left: +rect.left.toFixed(1),
      right: +rect.right.toFixed(1),
      width: +rect.width.toFixed(1),
      height: +rect.height.toFixed(1),
      centerYPct: +(((rect.top + rect.bottom) / 2 / window.innerHeight) * 100).toFixed(1),
      display: style.display,
      opacity: style.opacity,
    };
  };
  const topbar = document.querySelector(".galaxy-topbar");
  const hint = document.querySelector(".galaxy-search-hint");
  const search = box(".galaxy-search");
  const group = box(".galaxy-search-group");
  const hintBox = box(".galaxy-search-hint");
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    stats: window.__galaxyStats,
    theme: document.documentElement.getAttribute("data-theme"),
    search,
    group,
    hint: hintBox,
    searchCenterPct: search ? search.centerYPct : null,
    groupTopPct: group ? +((group.top / window.innerHeight) * 100).toFixed(1) : null,
    overlapsTopbar: Boolean(topbar && group && group.top < topbar.getBoundingClientRect().bottom - 1),
    hintInsideViewport: hintBox ? hintBox.bottom <= window.innerHeight : null,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
  };
})()`;

async function measure(browser) {
  const cases = [
    { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false },
    { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
  ];
  const results = {};

  for (const item of cases) {
    results[item.name] = {};
    for (const mode of ["webgl", "reduced-motion", "no-webgl"]) {
      const page = await openPage(browser.cdp);
      await page.setViewport({ width: item.width, height: item.height, dpr: item.dpr, mobile: item.mobile });
      await page.primeTheme("galaxy");

      if (mode === "reduced-motion") await page.setReducedMotion(true);
      if (mode === "no-webgl") {
        await page.send("Page.addScriptToEvaluateOnNewDocument", {
          source: `(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
              if (typeof type === "string" && type.includes("webgl")) return null;
              return original.call(this, type, ...rest);
            };
          })();`,
        });
      }

      await page.goto(`${BASE}/`);
      const expected = mode === "webgl" ? "webgl" : "poster";
      const ready = await page.waitFor(
        `window.__galaxyStats && window.__galaxyStats.mode === ${JSON.stringify(expected)}`,
        25000,
      );
      await sleep(mode === "webgl" ? 1600 : 900);

      const metrics = await page.evaluate(HOME_METRICS);
      const png = path.join(os.tmpdir(), `phase5b-measure-${item.name}-${mode}.png`);
      await page.screenshot(png);
      const centroid = await imageCentroid(png);

      results[item.name][mode] = {
        ready,
        ...metrics,
        centroid,
        consoleErrors: page.consoleErrors,
        pageErrors: page.pageErrors,
      };
      console.log(
        `[measure] ${item.name}/${mode}: search=${metrics.searchCenterPct}% ` +
          `groupTop=${metrics.groupTopPct}% centroidY=${centroid.centerYPct?.toFixed(1)}% ` +
          `stats=${JSON.stringify(metrics.stats)}`,
      );
      await page.close();
    }
  }

  console.log(JSON.stringify(results, null, 2));
  return results;
}

/* ============================================================
   home：首页构图三连拍（桌面 / 移动 / 禁用 WebGL 的静态回退）
   ============================================================ */

/**
 * 只拍首页三张：构图微调后快速留痕，不必跑整站 `shots`。
 * 前缀取 `SHOT_PREFIX`（默认 phase5c），文件名 `<前缀>-home-*`。
 */
async function homeShots(browser) {
  const prefix = process.env.SHOT_PREFIX || "phase5c";
  const outDir = path.join(ROOT, "docs/screenshots");
  const cases = [
    {
      slug: "home-galaxy-desktop",
      width: 1440,
      height: 900,
      dpr: 1,
      mobile: false,
      expect: "webgl",
    },
    {
      slug: "home-galaxy-mobile",
      width: 390,
      height: 844,
      dpr: 2,
      mobile: true,
      expect: "webgl",
    },
    {
      slug: "home-static-galaxy-desktop",
      width: 1440,
      height: 900,
      dpr: 1,
      mobile: false,
      noGl: true,
      expect: "fallback",
    },
  ];

  for (const item of cases) {
    const page = await openPage(browser.cdp);
    await page.setViewport({ width: item.width, height: item.height, dpr: item.dpr, mobile: item.mobile });
    await page.primeTheme("galaxy");
    if (item.noGl) {
      await page.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
            if (typeof type === "string" && type.includes("webgl")) return null;
            return original.call(this, type, ...rest);
          };
        })();`,
      });
    }

    await page.goto(`${BASE}/`);
    const ready = await page.waitFor(
      `window.__galaxyStats && window.__galaxyStats.mode === ${JSON.stringify(item.expect)}`,
      25000,
    );
    if (!ready) throw new Error(`${item.slug}: 没有进入 ${item.expect}`);
    await sleep(item.expect === "webgl" ? 1600 : 900);

    const file = path.join(outDir, `${prefix}-${item.slug}.png`);
    await page.screenshot(file);
    const metrics = await page.evaluate(HOME_METRICS);
    console.log(
      `[home] ${path.relative(ROOT, file)} mode=${metrics.stats?.mode} ` +
        `search=${metrics.searchCenterPct}% errors=${page.consoleErrors.length + page.pageErrors.length}`,
    );
    await page.close();
  }
}

/* ============================================================
   theme：主题切换回归（不刷新、滚动保持、刷新持久、强刷防闪、键盘）
   ============================================================ */

async function typeKey(page, key, code) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: 0 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: 0 });
}

async function themeCheck(browser) {
  const checks = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`[theme] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const page = await openPage(browser.cdp);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  const primed = await page.primeTheme("galaxy");
  await page.goto(`${BASE}/workspace`);
  await page.waitFor("document.querySelector('.rail-bottom .theme-switch-trigger')", 20000);
  await page.removePrimedTheme(primed);
  await sleep(900);

  record("首屏默认 galaxy", (await page.evaluate("document.documentElement.getAttribute('data-theme')")) === "galaxy");

  // 滚动后打开菜单，后续切主题不应重置滚动位置。
  // 工作台在 1440×900 下刚好铺满，临时压到 1440×700 让内容真的滚动起来。
  await page.setViewport({ width: 1440, height: 700, dpr: 1 });
  await sleep(300);
  // 工作台可能整个窗口滚动，也可能是内部容器滚动，这里找溢出最多的元素。
  const scroller = await page.evaluate(`(() => {
    const candidates = [document.scrollingElement, ...document.querySelectorAll("*")];
    let best = null;
    for (const el of candidates) {
      if (!el || !el.clientHeight) continue;
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow <= 8) continue;
      if (!best || overflow > best.overflow) best = { el, overflow };
    }
    if (!best) return null;
    const el = best.el;
    el.setAttribute("data-scroll-probe", "1");
    el.scrollTop = Math.min(240, best.overflow);
    return {
      tag: el.tagName,
      cls: String(el.className).slice(0, 40),
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  })()`);
  await sleep(200);
  const scrollBefore = await page.evaluate(`(() => {
    const el = document.querySelector("[data-scroll-probe='1']");
    return el ? el.scrollTop : window.scrollY;
  })()`);

  await page.clickSelector(".rail-bottom .theme-switch-trigger");
  await sleep(400);
  const opened = await page.evaluate(`(() => {
    const panel = document.querySelector(".rail-bottom .theme-switch-panel");
    const grid = document.querySelector(".rail-bottom .theme-switch-grid");
    const checked = document.querySelector(".rail-bottom .theme-option[aria-checked='true']");
    return {
      open: Boolean(panel),
      role: panel?.getAttribute("role") ?? null,
      options: grid ? grid.querySelectorAll("[role='radio']").length : 0,
      checked: checked?.textContent?.trim() ?? null,
      focusedInside: Boolean(document.activeElement?.closest(".theme-switch-panel")),
      activeElement: document.activeElement?.textContent?.trim().slice(0, 20) ?? null,
    };
  })()`);
  record(
    "点击头像打开菜单并聚焦选中项",
    opened.open && opened.options === 4 && opened.focusedInside,
    JSON.stringify(opened),
  );

  // 方向键切换：不刷新、滚动位置不变。
  await page.screenshot(path.join(ROOT, "docs/screenshots/phase5b-theme-menu-rail.png"));
  await typeKey(page, "ArrowRight", "ArrowRight");
  await sleep(300);
  const afterArrow = await page.evaluate(`({
    theme: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("pakp.theme"),
    scrollY: (() => {
      const el = document.querySelector("[data-scroll-probe='1']");
      return el ? el.scrollTop : window.scrollY;
    })(),
    navigations: performance.getEntriesByType("navigation").length,
  })`);
  record(
    "方向键切到 pine，无需刷新、滚动位置不变",
    afterArrow.theme === "pine" && afterArrow.stored === "pine" && afterArrow.scrollY === scrollBefore,
    JSON.stringify({ ...afterArrow, scrollBefore, scroller }),
  );

  // 恢复验收视口，后续刷新用 1440×900。
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await sleep(200);

  await typeKey(page, "ArrowRight", "ArrowRight");
  await typeKey(page, "ArrowDown", "ArrowDown");
  await sleep(200);
  const afterMidnight = await page.evaluate(
    `({ theme: document.documentElement.getAttribute("data-theme"), colorScheme: getComputedStyle(document.documentElement).colorScheme })`,
  );
  record(
    "连续方向键可达 sand / midnight，color-scheme 跟随",
    afterMidnight.theme === "midnight" && afterMidnight.colorScheme === "dark",
    JSON.stringify(afterMidnight),
  );

  // Esc 关闭并把焦点还给触发按钮。
  await typeKey(page, "Escape", "Escape");
  await sleep(200);
  const afterEsc = await page.evaluate(`({
    open: Boolean(document.querySelector(".rail-bottom .theme-switch-panel")),
    focusOnTrigger: document.activeElement === document.querySelector(".rail-bottom .theme-switch-trigger"),
  })`);
  record("Esc 关闭菜单并归还焦点", !afterEsc.open && afterEsc.focusOnTrigger, JSON.stringify(afterEsc));

  // 点击外部关闭。
  await page.clickSelector(".rail-bottom .theme-switch-trigger");
  await sleep(300);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1000, y: 200, button: "left", buttons: 1, clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1000, y: 200, button: "left", buttons: 1, clickCount: 1 });
  await sleep(300);
  const afterOutside = await page.evaluate(
    `Boolean(document.querySelector(".rail-bottom .theme-switch-panel"))`,
  );
  record("点击面板外关闭", afterOutside === false, String(afterOutside));

  // 回到 pine 再验证刷新持久。
  await page.evaluate(`localStorage.setItem("pakp.theme", "pine")`);
  await page.send("Page.reload", { ignoreCache: false });
  await sleep(1400);
  const afterReload = await page.evaluate(
    `document.documentElement.getAttribute("data-theme")`,
  );
  record("刷新后保持 pine", afterReload === "pine", String(afterReload));

  // 强刷 10 次，首帧即 pine（无白闪 / 无浅色→深色跳变）。
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__firstFrameTheme = null;
      window.requestAnimationFrame(() => {
        window.__firstFrameTheme = document.documentElement.getAttribute("data-theme");
      });
    })();`,
  });
  const flashes = [];
  for (let index = 0; index < 10; index += 1) {
    await page.send("Page.reload", { ignoreCache: true });
    // 等首帧 rAF 真的跑过；超时才记 null，避免把「还没画」误判成「画错主题」。
    await page.waitFor("window.__firstFrameTheme !== null && window.__firstFrameTheme !== undefined", 8000);
    const first = await page.evaluate("window.__firstFrameTheme");
    flashes.push(first);
  }
  record(
    "强刷 10 次首帧均为 pine",
    flashes.every((value) => value === "pine"),
    flashes.join(","),
  );

  // 首页固定深空：工作台切到 pine 后，首页标题仍是暖金。
  await page.goto(`${BASE}/`);
  await page.waitFor("window.__galaxyStats && window.__galaxyStats.mode === 'webgl'", 25000);
  await sleep(1200);
  const homePine = await page.evaluate(`(() => {
    const title = document.querySelector(".galaxy-title");
    const search = document.querySelector(".galaxy-search-input");
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      titleColor: title ? getComputedStyle(title).color : null,
      placeholderColor: search ? getComputedStyle(search, "::placeholder").color : null,
    };
  })()`);

  const primedHome = await page.primeTheme("galaxy");
  await page.goto(`${BASE}/`);
  await page.waitFor("window.__galaxyStats && window.__galaxyStats.mode === 'webgl'", 25000);
  await page.removePrimedTheme(primedHome);
  await sleep(900);
  const homeGalaxy = await page.evaluate(`(() => {
    const title = document.querySelector(".galaxy-title");
    const search = document.querySelector(".galaxy-search-input");
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      titleColor: title ? getComputedStyle(title).color : null,
      placeholderColor: search ? getComputedStyle(search, "::placeholder").color : null,
    };
  })()`);
  record(
    "首页不随工作台主题变色",
    homePine.titleColor === homeGalaxy.titleColor
      && homePine.placeholderColor === homeGalaxy.placeholderColor,
    `pine=${JSON.stringify(homePine)} galaxy=${JSON.stringify(homeGalaxy)}`,
  );

  // 首页右上角菜单也能开，并保存截图。
  await page.clickSelector(".theme-switch--home .theme-switch-trigger");
  await sleep(400);
  const homeMenu = await page.evaluate(
    `Boolean(document.querySelector(".theme-switch--home .theme-switch-panel"))`,
  );
  await page.screenshot(path.join(ROOT, "docs/screenshots/phase5b-theme-menu-home.png"));
  record("首页右上角菜单可打开", homeMenu === true, String(homeMenu));

  // 窄屏应变成底部抽屉：整宽、贴底、纵向排列。
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await sleep(600);
  // 切换移动仿真可能重建文档，菜单会回到关闭态，重新打开再量。
  await page.clickSelector(".theme-switch--home .theme-switch-trigger");
  await sleep(400);
  const mobileSheet = await page.evaluate(`(() => {
    const panel = document.querySelector(".theme-switch--home .theme-switch-panel");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      bottomGap: Math.round(window.innerHeight - rect.bottom),
      leftGap: Math.round(rect.left),
      flexDirection: style.flexDirection,
    };
  })()`);
  await page.screenshot(path.join(ROOT, "docs/screenshots/phase5b-theme-menu-mobile.png"));
  record(
    "移动端主题菜单为底部抽屉",
    Boolean(mobileSheet && mobileSheet.width >= 380 && mobileSheet.bottomGap <= 2 && mobileSheet.leftGap <= 2),
    JSON.stringify(mobileSheet),
  );

  await page.close();

  const failed = checks.filter((item) => !item.ok);
  console.log(failed.length ? `[theme] ${failed.length} 项失败` : "[theme] 全部通过");
  return checks;
}

/* ============================================================ */
const command = process.argv[2] ?? "probe";
const browser = await launchBrowser();

try {
  if (command === "poster") {
    await poster(browser);
  } else if (command === "probe") {
    const results = await probe(browser);
    console.log(JSON.stringify(results, null, 2));
  } else if (command === "shots") {
    await shots(browser);
  } else if (command === "measure") {
    await measure(browser);
  } else if (command === "home") {
    await homeShots(browser);
  } else if (command === "theme") {
    await themeCheck(browser);
  } else {
    throw new Error(`未知命令：${command}`);
  }
} finally {
  await browser.close();
}
