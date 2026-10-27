import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { link, rm, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * Stream a plain SQL dump to disk; neither stdout nor stderr grows with the DB.
 * It is written to `<filepath>.partial` and appears at `filepath` only once
 * complete, so a killed process never leaves a truncated dump under the final name.
 */
export async function streamPgDump(input: {
  filepath: string;
  argvUrl: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<void> {
  const dump = spawn("pg_dump", [input.argvUrl], {
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stderrBytes = 0;
  dump.stderr.on("data", (chunk: Buffer) => {
    const kept = chunk.subarray(0, Math.max(0, 65_536 - stderrBytes));
    stderrBytes += kept.length;
    stderr += kept.toString("utf8");
  });
  const exited = new Promise<void>((resolve, reject) => {
    dump.on("error", reject);
    dump.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    dump.kill("SIGKILL");
  }, input.timeoutMs);
  // A timestamp collision must not truncate or remove another run's backup.
  const partialPath = `${input.filepath}.partial`;
  let ownsFile = false;
  const output = createWriteStream(partialPath, { flags: "wx" });
  output.on("open", () => { ownsFile = true; });
  const streamed = pipeline(
    dump.stdout,
    createGzip(),
    output,
    { signal: controller.signal },
  );
  try {
    // EOF alone is insufficient: pg_dump can write valid SQL and then fail.
    await Promise.all([exited, streamed]);
    // link() refuses an existing final name where rename() would overwrite it.
    await link(partialPath, input.filepath);
    await unlink(partialPath);
  } catch (error) {
    controller.abort();
    dump.kill("SIGKILL");
    // Close the file before removing it, and reap the child before returning.
    await Promise.allSettled([exited, streamed]);
    if (ownsFile) await rm(partialPath, { force: true });
    if (timedOut) throw new Error(`pg_dump timed out after ${input.timeoutMs} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
