import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamPgDump } from "@/lib/backup-dump";

const exec = promisify(execFile);

describe("streamPgDump", () => {
  let dir: string;
  let input: Parameters<typeof streamPgDump>[0];
  function command(body: string) {
    const executable = path.join(dir, "pg_dump");
    writeFileSync(executable, `#!${process.execPath}\n${body}\n`);
    chmodSync(executable, 0o755);
  }
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "backup-dump-"));
    input = {
      filepath: path.join(dir, "dump.sql.gz"),
      argvUrl: "postgresql://fixture@unused/synthetic",
      env: { PATH: dir },
      timeoutMs: 10_000,
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a complete gzip containing the exact dump bytes", async () => {
    command('process.stdout.write("COPY example FROM stdin;\\nrow\\n\\\\.\\n");');
    await streamPgDump(input);
    expect(gunzipSync(readFileSync(input.filepath)).toString()).toBe("COPY example FROM stdin;\nrow\n\\.\n");
  }, 15_000);

  it("rejects a nonzero exit even after a complete stdout and removes the partial backup", async () => {
    command('process.stdout.end("valid SQL\\n", () => { process.stderr.write("dump failed"); process.exitCode = 7; });');
    await expect(streamPgDump(input)).rejects.toThrow("pg_dump exited 7: dump failed");
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("drains noisy stderr with bounded diagnostics", async () => {
    command('process.stderr.write("x".repeat(1024 * 1024), () => { process.exitCode = 2; });');
    const error = await streamPgDump(input).catch((err: Error) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message.length).toBeLessThan(66_000);
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("reports a missing executable without an unhandled rejection or partial file", async () => {
    await expect(streamPgDump(input)).rejects.toMatchObject({ code: "ENOENT", syscall: "spawn pg_dump" });
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("kills a hung dump and removes its partial backup on timeout", async () => {
    command('process.stdout.write("partial SQL"); setInterval(() => {}, 1000);');
    await expect(streamPgDump({ ...input, timeoutMs: 200 })).rejects.toThrow("timed out");
    expect(existsSync(input.filepath)).toBe(false);
  }, 15_000);

  it("rejects a destination failure and stops the producer", async () => {
    command('setInterval(() => process.stdout.write("row\\n"), 10);');
    const filepath = path.join(dir, "missing", "dump.sql.gz");
    await expect(streamPgDump({ ...input, filepath })).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(filepath)).toBe(false);
  }, 15_000);

  it("keeps peak memory flat when a synthetic dump grows from 16 to 512 MiB", async () => {
    // Real processes and streams, isolated from Vitest's heap. The producer reuses
    // one chunk and honours backpressure; resourceUsage catches even synchronous
    // allocations that an event-loop sampler would miss.
    command(`
      const { once } = require("node:events");
      (async () => {
        const chunk = Buffer.alloc(64 * 1024, "synthetic row\\n");
        for (let n = 0; n < Number(process.env.DUMP_BYTES); n += chunk.length) {
          if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
        }
      })().catch(() => { process.exitCode = 1; });
    `);
    const moduleUrl = pathToFileURL(path.resolve("src/lib/backup-dump.ts")).href;
    const script = `
      import { streamPgDump } from ${JSON.stringify(moduleUrl)};
      const input = ${JSON.stringify(input)};
      input.timeoutMs = 30000;
      await streamPgDump({ ...input, env: { ...input.env, DUMP_BYTES: String(16 * 1024 * 1024) } });
      const small = process.resourceUsage().maxRSS;
      await streamPgDump({ ...input, env: { ...input.env, DUMP_BYTES: String(512 * 1024 * 1024) } });
      console.log(JSON.stringify({ small, large: process.resourceUsage().maxRSS }));
    `;
    const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], { timeout: 60_000 });
    const memory = JSON.parse(stdout) as { small: number; large: number };
    // maxRSS is KiB. A whole-dump buffer adds at least 512 MiB; allow 64 MiB
    // for allocator/GC variation while the dump grows by 496 MiB.
    expect(memory.large - memory.small).toBeLessThan(64 * 1024);
  }, 65_000);
});
