// The two sheets, measured against each other without React in the way.
//
//   pnpm demo:bench                 the default sheet
//   pnpm demo:bench --rows=15000    a bigger one
//   pnpm demo:bench --runs=7        more repetitions, median reported

import { subscribe } from "#weft";
import { key, sampleSheet, sizeOf } from "./common/sample.ts";
import type { Contents, SheetShape } from "./common/sample.ts";
import { createSheet as classic } from "./spreadsheet/store.ts";
import { createSheet as onWeft } from "./spreadsheet-weft/sheet.ts";

interface Sheet {
  watch(at: string, told: () => void): () => void;
  set(at: string, text: string): void;
  shown(at: string): string;
  worked(): number;
  resetWorked(): void;
}

interface Subject {
  name: string;
  open(cells: Contents): Sheet;
}

const subjects: Subject[] = [
  {
    name: "classic",
    open(cells) {
      const sheet = classic(cells);
      return {
        watch: (at, told) => sheet.subscribe(at, told),
        set: (at, text) => sheet.set(at, text),
        shown: (at) => sheet.shown(at),
        worked: () => sheet.recomputes(),
        resetWorked: () => sheet.resetRecomputes(),
      };
    },
  },
  {
    name: "weft, no blocks",
    open: (cells) => wrapWeft(cells, false),
  },
  {
    name: "weft, blocks",
    open: (cells) => wrapWeft(cells, true),
  },
];

function wrapWeft(cells: Contents, blocks: boolean): Sheet {
  const sheet = onWeft(cells, { blocks });
  return {
    watch: (at, told) => subscribe(sheet.shown(at), told),
    set: (at, text) => sheet.set(at, text),
    shown: (at) => sheet.shown(at).peek(),
    worked: () => sheet.recomputes(),
    resetWorked: () => sheet.resetRecomputes(),
  };
}

interface Scene {
  name: string;
  /** Which cells a screen in this scene is showing. */
  watched(shape: SheetShape): string[];
}

const scenes: Scene[] = [
  {
    name: "first rows on screen",
    watched: (shape) => cellsOfRows(shape, 0, 30),
  },
  {
    name: "first rows and the totals row",
    watched: (shape) => [...cellsOfRows(shape, 0, 30), ...cellsOfRows(shape, shape.rows - 1, 1)],
  },
];

function cellsOfRows(shape: SheetShape, from: number, count: number): string[] {
  const cells: string[] = [];
  for (let row = from; row < Math.min(from + count, shape.rows); row++) {
    for (let col = 0; col < shape.cols; col++) cells.push(key(row, col));
  }
  return cells;
}

interface Run {
  open: number;
  look: number;
  edit: number;
  worked: number;
  told: number;
}

function once(subject: Subject, scene: Scene, shape: SheetShape, cells: Contents): Run {
  const watched = scene.watched(shape);
  let told = 0;

  const openedAt = performance.now();
  const sheet = subject.open(cells);
  const open = performance.now() - openedAt;

  const lookedAt = performance.now();
  const stops = watched.map((at) => sheet.watch(at, () => told++));
  const look = performance.now() - lookedAt;

  told = 0;
  sheet.resetWorked();
  const editedAt = performance.now();
  sheet.set("A1", "3");
  const edit = performance.now() - editedAt;
  const worked = sheet.worked();

  for (const stop of stops) stop();
  return { open, look, edit, worked, told };
}

function median(numbers: number[]): number {
  const sorted = numbers.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

const ms = (value: number): string => (value >= 100 ? value.toFixed(0) : value.toFixed(1));
const count = (value: number): string => value.toLocaleString("en-US");

function table(rows: string[][]): string {
  const widths = (rows[0] ?? []).map((_head, col) =>
    Math.max(...rows.map((row) => (row[col] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, col) =>
          col === 0 ? cell.padEnd(widths[col] as number) : cell.padStart(widths[col] as number),
        )
        .join("   "),
    )
    .join("\n");
}

// -- the run ---------------------------------------------------------------

const asked = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => arg.slice(2).split("=") as [string, string]),
);
const rows = Number(asked.get("rows") ?? 1000);
const runs = Number(asked.get("runs") ?? 3);
const shape: SheetShape = { rows, cols: 26 };
const cells = sampleSheet(shape);

console.log(
  `sheet ${shape.rows} x ${shape.cols} = ${count(sizeOf(shape))} cells, ` +
    `median of ${runs} run${runs === 1 ? "" : "s"}, ${process.version}\n`,
);

for (const scene of scenes) {
  const watched = scene.watched(shape).length;
  console.log(`${scene.name} — ${count(watched)} cells watched`);

  const lines: string[][] = [
    ["", "open", "first look", "edit A1", "worked out", "told", "vs classic"],
  ];
  let classicEdit = 0;

  for (const subject of subjects) {
    const taken: Run[] = [];
    for (let run = 0; run < runs; run++) taken.push(once(subject, scene, shape, cells));
    const edit = median(taken.map((r) => r.edit));
    if (subject.name === "classic") classicEdit = edit;
    lines.push([
      subject.name,
      `${ms(median(taken.map((r) => r.open)))} ms`,
      `${ms(median(taken.map((r) => r.look)))} ms`,
      `${ms(edit)} ms`,
      count(median(taken.map((r) => r.worked))),
      count(median(taken.map((r) => r.told))),
      classicEdit === 0 ? "—" : `${(classicEdit / edit).toFixed(1)}x`,
    ]);
  }

  console.log(table(lines));
  console.log();
}
