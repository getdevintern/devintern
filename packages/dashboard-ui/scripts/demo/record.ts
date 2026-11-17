/**
 * Record a short tour of the seeded demo dashboard as numbered PNG frames.
 *
 *   bun run scripts/demo/record.ts <base-url> <run-id> <frames-dir> <cdp-port>
 *
 * Drives an already running headless Chromium over the DevTools protocol (no
 * browser-automation dependency): it moves a drawn cursor, clicks through the
 * views, and captures one frame per step at a fixed 10 fps. `capture.sh`
 * starts Chromium and turns the frames into a GIF.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [baseUrl, runId, framesDir, cdpPort] = process.argv.slice(2);
if (!baseUrl || !runId || !framesDir || !cdpPort) {
  console.error("usage: record.ts <base-url> <run-id> <frames-dir> <cdp-port>");
  process.exit(1);
}

const WIDTH = 1280;
const HEIGHT = 800;
const FRAME_MS = 100;

interface Target {
  type: string;
  webSocketDebuggerUrl: string;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as Target[];
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("No page target found on the DevTools port");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", () => reject(new Error("DevTools socket failed to open")));
});

let nextId = 0;
const pending = new Map<number, (result: Record<string, unknown>) => void>();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data)) as {
    id?: number;
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (message.id === undefined) return;
  if (message.error) throw new Error(`DevTools: ${message.error.message}`);
  pending.get(message.id)?.(message.result ?? {});
  pending.delete(message.id);
});

function send(method: string, params: Record<string, unknown> = {}) {
  const id = ++nextId;
  return new Promise<Record<string, unknown>>((resolve) => {
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate<T>(expression: string): Promise<T> {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  return (result.result as { value: T }).value;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(framesDir, { recursive: true });
let frameCount = 0;
async function frame() {
  const started = Date.now();
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const name = `frame-${String(frameCount++).padStart(4, "0")}.png`;
  await Bun.write(join(framesDir, name), Buffer.from(String(shot.data), "base64"));
  // Keep real time roughly in step with the recording so UI transitions and
  // the dashboard's own polling look natural.
  await sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
}

async function hold(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += FRAME_MS) await frame();
}

const cursor = { x: WIDTH / 2, y: HEIGHT / 2 };
async function moveTo(x: number, y: number, ms = 700) {
  const steps = Math.max(1, Math.round(ms / FRAME_MS));
  const from = { ...cursor };
  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const eased = t * t * (3 - 2 * t);
    cursor.x = from.x + (x - from.x) * eased;
    cursor.y = from.y + (y - from.y) * eased;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cursor.x, y: cursor.y });
    await frame();
  }
}

async function click() {
  const at = { x: cursor.x, y: cursor.y, button: "left", clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
}

/** Bounding box of the smallest element matching `selector` whose text includes `text`. */
async function rectOf(selector: string, text: string): Promise<Rect> {
  const rect = await evaluate<Rect | null>(`(() => {
    const boxes = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((node) => node.textContent.includes(${JSON.stringify(text)}))
      .map((node) => node.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .sort((a, b) => a.width * a.height - b.width * b.height);
    const r = boxes[0];
    if (!r) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  if (!rect) throw new Error(`Element not found: ${selector} containing "${text}"`);
  return rect;
}

async function moveToElement(selector: string, text: string, ms?: number) {
  const rect = await rectOf(selector, text);
  await moveTo(rect.x + Math.min(rect.width / 2, 60), rect.y + rect.height / 2, ms);
}

// A drawn pointer: headless screenshots do not include the system cursor.
const cursorScript = `(() => {
  const install = () => {
    const el = document.createElement("div");
    el.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0;width:22px;height:22px;pointer-events:none;transform:translate(${cursor.x}px,${cursor.y}px)";
    el.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 9-7 1.5L8.5 20z" fill="#fff" stroke="#0b1326" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(el);
    addEventListener("mousemove", (e) => {
      el.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
    }, true);
  };
  if (document.documentElement) install();
  else addEventListener("DOMContentLoaded", install);
})()`;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.addScriptToEvaluateOnNewDocument", { source: cursorScript });

// 1. Runs: the queue of work that happened without anyone watching.
await send("Page.navigate", { url: `${baseUrl}/#/runs` });
await sleep(2500);
await hold(2200);

// 2. Open the featured run and expand its timeline.
await moveToElement("tr, [role='row'], a, button", "PROJ-1842");
await hold(300);
await click();
await sleep(600);
if (!(await evaluate<string>("location.hash")).includes(`/runs/${runId}`)) {
  await evaluate(`location.hash = "#/runs/${runId}"`);
  await sleep(600);
}
await hold(2500);
await moveToElement("button", "Expand all");
await hold(300);
await click();
await hold(3500);

// 3. Pull requests waiting on a human.
await moveToElement("nav a, aside a", "Pull requests");
await hold(200);
await click();
await hold(2800);

// 4. Scheduled automations.
await moveToElement("nav a, aside a", "Automations");
await hold(200);
await click();
await hold(2500);

// 5. Workspace: hover a tracker source and a repository to trace routes.
await moveToElement("nav a, aside a", "Workspace");
await hold(200);
await click();
await hold(1800);
await moveToElement("span, strong, div, p", "engineering", 900);
await hold(2200);
await moveToElement("span, strong, div, p", "acme/web", 900);
await hold(2500);

socket.close();
console.log(`Recorded ${frameCount} frames to ${framesDir}`);
