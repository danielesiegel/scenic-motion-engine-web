// scenicsynths video exporter
//
// Usage: run `npm run dev` in another terminal first, then:
//   npm run render -- --track mytrack --size 1920x1080 --fps 60 --bars 32
//
// Pipes PNG frames from Playwright's canvas screenshots into ffmpeg's stdin
// via image2pipe. Optionally muxes audio from assets/audio/<track>.wav.
// The browser engine is a pure function of time, so renders are deterministic.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";

type Preset = "1920x1080" | "1080x1080" | "1080x1920";
const PRESETS: Record<Preset, [number, number]> = {
  "1920x1080": [1920, 1080],
  "1080x1080": [1080, 1080],
  "1080x1920": [1080, 1920],
};

interface Args {
  track?: string;
  fps: number;
  width: number;
  height: number;
  start: number;
  end?: number;
  bars?: number;
  out?: string;
  audioMux: boolean;
  url: string;
  headful: boolean;
  viewportPad: number;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  throw new Error(`invalid boolean: ${v}`);
}

function parseSize(s: string): [number, number] {
  if (s in PRESETS) return PRESETS[s as Preset];
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`invalid --size: ${s}`);
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

function parseCliArgs(): Args {
  const { values } = parseArgs({
    options: {
      track: { type: "string" },
      fps: { type: "string", default: "60" },
      size: { type: "string", default: "1920x1080" },
      start: { type: "string", default: "0" },
      end: { type: "string" },
      bars: { type: "string" },
      out: { type: "string" },
      "audio-mux": { type: "string", default: "true" },
      url: { type: "string", default: "http://127.0.0.1:5173/" },
      headful: { type: "boolean", default: false },
      "viewport-pad": { type: "string", default: "32" },
    },
    strict: true,
  });

  const [width, height] = parseSize(values.size as string);
  return {
    track: values.track as string | undefined,
    fps: parseInt(values.fps as string, 10),
    width,
    height,
    start: parseFloat(values.start as string),
    end: values.end !== undefined ? parseFloat(values.end as string) : undefined,
    bars: values.bars !== undefined ? parseInt(values.bars as string, 10) : undefined,
    out: values.out as string | undefined,
    audioMux: parseBool(values["audio-mux"] as string | undefined, true),
    url: values.url as string,
    headful: values.headful as boolean,
    viewportPad: parseInt(values["viewport-pad"] as string, 10),
  };
}

interface PageMeta {
  bpm: number;
  duration: number;
  loadedTrack: string | undefined;
}

async function readPageMeta(page: Page): Promise<PageMeta> {
  return await page.evaluate(() => {
    const s = (window as unknown as { __scenicsynths: {
      source: { bpm: number; duration: number };
      config: { audio?: { track?: string | null } };
    } }).__scenicsynths;
    return {
      bpm: s.source.bpm,
      duration: s.source.duration,
      loadedTrack: s.config?.audio?.track ?? undefined,
    };
  });
}

async function configureCanvas(page: Page, w: number, h: number): Promise<void> {
  await page.evaluate((wh: { width: number; height: number }) => {
    const { width, height } = wh;
    const s = (window as unknown as { __scenicsynths: {
      config: { canvas: { width: number; height: number; dpr: number } };
    } }).__scenicsynths;
    s.config.canvas.width = width;
    s.config.canvas.height = height;
    s.config.canvas.dpr = 1;
    const c = document.getElementById("canvas") as HTMLCanvasElement | null;
    if (c) {
      c.width = width;
      c.height = height;
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    }
  }, { width: w, height: h });
  await page.waitForTimeout(50);
}

function buildFfmpegArgs(
  fps: number,
  out: string,
  audioPath: string | null,
  start: number,
  end: number,
): string[] {
  const args: string[] = ["-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-"];
  if (audioPath) {
    args.push("-ss", String(start), "-to", String(end), "-i", audioPath);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart");
  if (audioPath) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }
  args.push(out);
  return args;
}

function spawnFfmpeg(args: string[]): ChildProcessWithoutNullStreams {
  const proc = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stderrBuf = "";
  proc.stderr.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
  });
  proc.on("error", (e) => {
    console.error("ffmpeg spawn error:", e.message);
  });
  (proc as unknown as { _stderrTail: () => string })._stderrTail = () => stderrBuf;
  return proc;
}

async function writeFrame(proc: ChildProcessWithoutNullStreams, buf: Buffer): Promise<void> {
  if (!proc.stdin.write(buf)) {
    await new Promise<void>((r) => proc.stdin.once("drain", () => r()));
  }
}

async function closeFfmpeg(proc: ChildProcessWithoutNullStreams): Promise<number> {
  proc.stdin.end();
  return await new Promise<number>((resolveExit, rejectExit) => {
    proc.on("close", (code) => resolveExit(code ?? 0));
    proc.on("error", rejectExit);
  });
}

async function waitForScenicsynths(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { __scenicsynths?: unknown }).__scenicsynths !== "undefined",
    undefined,
    { timeout: 30_000 },
  );
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const projectRoot = resolve(import.meta.dirname, "..");
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !args.headful });
    const context = await browser.newContext({
      viewport: {
        width: args.width + args.viewportPad,
        height: args.height + args.viewportPad,
      },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    try {
      await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (e) {
      console.error(`\nCould not reach ${args.url}.`);
      console.error(`Hint: run \`npm run dev\` in another terminal, then retry.\n`);
      throw e;
    }

    await waitForScenicsynths(page);
    await configureCanvas(page, args.width, args.height);
    const meta = await readPageMeta(page);

    const trackName = args.track ?? meta.loadedTrack ?? "track";
    const start = args.start;
    let end: number;
    if (args.bars !== undefined) {
      const barLen = (60 / meta.bpm) * 4;
      end = start + args.bars * barLen;
    } else if (args.end !== undefined) {
      end = args.end;
    } else {
      end = meta.duration;
    }
    if (end <= start) throw new Error(`end (${end}) <= start (${start})`);

    const audioPath = resolve(projectRoot, "assets", "audio", `${trackName}.wav`);
    const haveAudio = args.audioMux && existsSync(audioPath);

    const out = resolve(
      projectRoot,
      args.out ?? `renders/${trackName}_${args.width}x${args.height}_${args.fps}.mp4`,
    );
    mkdirSync(dirname(out), { recursive: true });

    const totalFrames = Math.floor((end - start) * args.fps);
    console.log(
      `scenicsynths render: track=${trackName} size=${args.width}x${args.height} fps=${args.fps}`,
    );
    console.log(
      `  bpm=${meta.bpm} duration=${meta.duration.toFixed(3)}s window=[${start.toFixed(3)}, ${end.toFixed(3)}]s frames=${totalFrames} audio=${haveAudio}`,
    );
    console.log(`  out=${out}`);

    const ffmpegArgs = buildFfmpegArgs(args.fps, out, haveAudio ? audioPath : null, start, end);
    const ff = spawnFfmpeg(ffmpegArgs);

    const t0 = Date.now();
    const canvas = await page.$("#canvas");
    if (!canvas) throw new Error("no #canvas element on page");

    const logEvery = Math.max(1, Math.min(60, Math.floor(totalFrames / 10) || 1));

    for (let i = 0; i < totalFrames; i++) {
      const t = start + i / args.fps;
      await page.evaluate((tt: number) => {
        (window as unknown as { __scenicsynths: { renderFrameAt: (t: number) => void } })
          .__scenicsynths.renderFrameAt(tt);
      }, t);
      const buf = await canvas.screenshot({ type: "png", omitBackground: false });
      await writeFrame(ff, buf);

      if ((i + 1) % logEvery === 0 || i === totalFrames - 1) {
        const elapsed = (Date.now() - t0) / 1000;
        const pct = ((i + 1) / totalFrames) * 100;
        const fps = (i + 1) / elapsed;
        console.log(
          `  frame ${i + 1}/${totalFrames} (${pct.toFixed(1)}%) at ${fps.toFixed(2)} fps`,
        );
      }
    }

    const code = await closeFfmpeg(ff);
    if (code !== 0) {
      const tail = (ff as unknown as { _stderrTail: () => string })._stderrTail();
      throw new Error(`ffmpeg exited ${code}\n${tail}`);
    }

    const dur = (Date.now() - t0) / 1000;
    console.log(`done: ${out} (${dur.toFixed(2)}s wall)`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  }
}

main().catch((e: Error) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
