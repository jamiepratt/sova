// Native delivery belongs in the integration tier. Keep the immediate write after start: waiting
// for a readiness event first would hide a lost first change rather than test it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExtension, type ExtensionEntry } from "../extensions";
import { ExtensionSync } from "./extensions";

const entry = (id: string, dist: string): ExtensionEntry => ({ id, title: id, dist, api: "http://127.0.0.1:7001" });

test("a native manifest change immediately after start is pushed without reconcile or readiness wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-ext-native-"));
  const manifest = join(root, "extensions.json");
  const dist = join(root, "dist");
  mkdirSync(dist);
  const observations: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve, reject) => {
    delivered = resolve;
    timer = setTimeout(() => reject(new Error(`native watcher did not publish: ${JSON.stringify(observations)}`)), 15_000);
  });
  const b = new ExtensionSync({ hostId: "b", file: join(root, "b.json"), local: () => [], validate: validateExtension });
  const a = new ExtensionSync({
    hostId: "a", file: join(root, "a.json"), validate: validateExtension,
    local: () => {
      try {
        const d = JSON.parse(readFileSync(manifest, "utf8")) as { extensions: unknown[] };
        return d.extensions.map(validateExtension).flatMap((v) => "entry" in v ? [v.entry] : []);
      } catch {
        return [];
      }
    },
    watch: (directory, listener) => {
      const watcher = watch(directory, { persistent: false }, (event, filename) => {
        observations.push({ event, filename, filenameType: typeof filename, buffer: Buffer.isBuffer(filename) });
        listener(event, filename);
      });
      watcher.on("error", (error) => observations.push({ error: error.message }));
      observations.push({ directory, registered: true });
      return watcher;
    },
    peers: () => [{ id: "b", extensions: async () => b.published(), notify: async (list) => {
      observations.push({ published: list.entries.map((e) => e.id) });
      b.receive("a", structuredClone(list));
      if (b.peerEntries().some((p) => p.entry.id === "fresh")) delivered();
    } }],
  });
  try {
    a.start(manifest, 30);
    writeFileSync(manifest, JSON.stringify({ version: 1, extensions: [entry("fresh", dist)] }));
    observations.push({ written: true });
    await delivery;
    assert.deepEqual(b.peerEntries().map((p) => [p.entry.id, p.from]), [["fresh", "a"]]);
  } finally {
    clearTimeout(timer);
    a.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
