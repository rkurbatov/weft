// What a sheet must do, whoever keeps it. The weft demo answers the same
// questions with its own file, so the two can be held to one standard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet } from "./store.ts";
import { refsOf } from "./depends.ts";
import { refName } from "../common/address.ts";
import { sampleSheet, key } from "../common/sample.ts";

function small() {
  return createSheet(
    new Map([
      ["A1", "1"],
      ["A2", "2"],
      ["A3", "=A1 + A2"],
      ["B1", "=A3 * 10"],
      ["C1", "=SUM(A1:A3)"],
    ]),
  );
}

test("it works the sheet out on the way in", () => {
  const sheet = small();
  assert.equal(sheet.shown("A3"), "3");
  assert.equal(sheet.shown("B1"), "30");
  assert.equal(sheet.shown("C1"), "6");
});

test("a change travels as far as it has to and no further", () => {
  const sheet = small();
  const told: string[] = [];
  for (const at of ["A1", "A2", "A3", "B1", "C1"]) sheet.subscribe(at, () => told.push(at));
  sheet.set("A1", "5");
  assert.equal(sheet.shown("A3"), "7");
  assert.equal(sheet.shown("B1"), "70");
  assert.equal(sheet.shown("C1"), "14"); // A1 + A2 + A3, and A3 moved too
  assert.deepEqual(told.toSorted(), ["A1", "A3", "B1", "C1"]);
});

test("a change that alters nothing tells nobody", () => {
  const sheet = small();
  let told = 0;
  sheet.subscribe("B1", () => told++);
  sheet.set("A1", "1"); // the same value written again
  assert.equal(told, 0);
});

test("editing a formula rewires what it depends on", () => {
  const sheet = small();
  sheet.set("B1", "=A2 * 10");
  assert.equal(sheet.shown("B1"), "20");
  sheet.set("A1", "9"); // B1 no longer leans on A1 through A3? it still does, through nothing
  assert.equal(sheet.shown("B1"), "20");
  sheet.set("A2", "3");
  assert.equal(sheet.shown("B1"), "30");
});

test("a loop is named, not hung", () => {
  const sheet = small();
  sheet.set("A1", "=A3");
  assert.equal(sheet.shown("A1"), "#CYCLE!");
  assert.equal(sheet.shown("A3"), "#CYCLE!");
  sheet.set("A1", "4"); // and it recovers when the loop is cut
  assert.equal(sheet.shown("A1"), "4");
  assert.equal(sheet.shown("A3"), "6");
});

test("text and errors travel like values do", () => {
  const sheet = small();
  sheet.set("A2", "note");
  assert.equal(sheet.shown("A3"), "1");
  sheet.set("A2", "=1/0");
  assert.equal(sheet.shown("A2"), "#DIV/0!");
  assert.equal(sheet.shown("A3"), "#DIV/0!");
});

test("the sample sheet adds up, and one edit runs the whole chain", () => {
  const shape = { rows: 200, cols: 26 };
  const sheet = createSheet(sampleSheet(shape));
  const rows = shape.rows - 1;
  const totalAt = key(shape.rows - 1, 0);
  assert.equal(sheet.shown(totalAt), String((rows * (rows + 1)) / 2));

  sheet.resetRecomputes();
  sheet.set("A1", "2");
  assert.equal(sheet.shown(totalAt), String((rows * (rows + 1)) / 2 + 1));
  // Everything downstream is worked out eagerly, on screen or not.
  assert.ok(sheet.recomputes() > 200, `only ${sheet.recomputes()} cells were recomputed`);
});

test("the hand-written sheet must know a formula's references in advance", () => {
  assert.deepEqual(refsOf("=A1 + B2").map(refName), ["A1", "B2"]);
  assert.deepEqual(refsOf("=SUM(A1:A3)").map(refName), ["A1", "A2", "A3"]);
  assert.deepEqual(refsOf("7"), []);
});
