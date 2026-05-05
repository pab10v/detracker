import assert from "node:assert/strict";
import { it } from "node:test";
import { initTracker, updateEKF, getStateX } from "../build/debug.js";

it("initTracker initializes state", () => {
  initTracker(1);
  const x0 = getStateX(1);
  assert.equal(typeof x0, "number");
});

it("updateEKF returns a finite zScore and updates x0", () => {
  const domainId = 2;
  initTracker(domainId);
  const before = getStateX(domainId);
  const zScore = updateEKF(domainId, 0.8, 0.2, 0.1);
  const after = getStateX(domainId);
  assert.equal(Number.isFinite(zScore), true);
  assert.equal(after !== before, true);
});
