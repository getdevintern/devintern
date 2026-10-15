import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  RESUME_NOTE_VERSION,
  buildResumeNote,
  consumeResumeNote,
  readResumeNote,
  resumeNoteRunIds,
  writeResumeNote,
} from "../src/lib/state/resume-note";
import type { ResumeNote } from "../src/lib/state/resume-note";
import type { RunRecord } from "../src/lib/state/run-recorder";

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: 1,
    origin: "task",
    status: "in_progress",
    startedAt: 1_000,
    ...overrides,
  } as RunRecord;
}

describe("buildResumeNote", () => {
  test("maps in-flight runs and preserves resumable fields", () => {
    const note = buildResumeNote(
      [
        run({
          id: 7,
          taskKey: "PROJ-1",
          branch: "feature/proj-1",
          attempt: 2,
          repo: "web",
          team: "platform",
          harness: "claude",
        }),
        run({ id: 8, origin: "pr_mention", taskKey: undefined, status: "in_progress" }),
      ],
      { signal: "SIGTERM", now: 42 },
    );

    expect(note.version).toBe(RESUME_NOTE_VERSION);
    expect(note.createdAt).toBe(42);
    expect(note.signal).toBe("SIGTERM");
    expect(note.runs).toHaveLength(2);
    expect(note.runs[0]).toEqual({
      runId: 7,
      origin: "task",
      taskKey: "PROJ-1",
      branch: "feature/proj-1",
      attempt: 2,
      repo: "web",
      team: "platform",
      harness: "claude",
      startedAt: 1_000,
    });
    expect(note.runs[1]?.runId).toBe(8);
  });

  test("drops runs that are no longer in progress", () => {
    const note = buildResumeNote([
      run({ id: 1, status: "succeeded" }),
      run({ id: 2, status: "in_progress" }),
    ]);

    expect(note.runs.map((entry) => entry.runId)).toEqual([2]);
  });

  test("omits the signal when none was given", () => {
    expect(buildResumeNote([run({ id: 3 })]).signal).toBeUndefined();
  });
});

describe("resume note persistence", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resume-note-"));
    mkdirSync(join(dir, "state"), { recursive: true });
    path = join(dir, "state", "resume-note.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a note through an atomic write", () => {
    const note = buildResumeNote([run({ id: 5, taskKey: "PROJ-5", branch: "feature/proj-5" })], {
      signal: "SIGTERM",
      now: 99,
    });

    expect(writeResumeNote(path, note)).toBe(true);
    expect(existsSync(path)).toBe(true);
    // No partial temp file survives a successful rename.
    expect(existsSync(`${path}.tmp`)).toBe(false);

    const read = readResumeNote(path);
    expect(read).toEqual(note);
  });

  test("read returns null for a missing note", () => {
    expect(readResumeNote(path)).toBeNull();
  });

  test("read returns null for malformed JSON and incompatible versions", () => {
    writeResumeNote(path, buildResumeNote([run({ id: 1 })]));

    writeFileSync(path, "{not json", "utf8");
    expect(readResumeNote(path)).toBeNull();

    const wrongVersion = { ...buildResumeNote([run({ id: 1 })]), version: 999 };
    writeFileSync(path, JSON.stringify(wrongVersion), "utf8");
    expect(readResumeNote(path)).toBeNull();
  });

  test("skips individual malformed entries but keeps valid ones", () => {
    const raw = {
      version: RESUME_NOTE_VERSION,
      createdAt: 1,
      runs: [
        { runId: "not-a-number", origin: "task", startedAt: 1 },
        { runId: 6, origin: "task", startedAt: 1 },
      ],
    };
    writeFileSync(path, JSON.stringify(raw), "utf8");

    const read = readResumeNote(path);
    expect(read?.runs.map((entry) => entry.runId)).toEqual([6]);
  });

  test("consume deletes the note and is a one-shot read", () => {
    const note = buildResumeNote([run({ id: 4, taskKey: "PROJ-4" })]);
    writeResumeNote(path, note);

    expect(consumeResumeNote(path)).toEqual(note);
    expect(existsSync(path)).toBe(false);
    expect(consumeResumeNote(path)).toBeNull();
  });

  test("consume removes a malformed note so it is not reprocessed", () => {
    writeFileSync(path, "{broken", "utf8");

    expect(consumeResumeNote(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("writes valid JSON a human can inspect", () => {
    writeResumeNote(path, buildResumeNote([run({ id: 2 })], { signal: "SIGTERM" }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: RESUME_NOTE_VERSION });
  });
});

describe("resumeNoteRunIds", () => {
  test("collects ids and handles a missing note", () => {
    const note: ResumeNote = buildResumeNote([run({ id: 3 }), run({ id: 9 })]);
    expect([...resumeNoteRunIds(note)].sort((a, b) => a - b)).toEqual([3, 9]);
    expect(resumeNoteRunIds(null).size).toBe(0);
  });
});
