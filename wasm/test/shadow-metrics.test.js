import assert from "node:assert/strict";
import { it } from "node:test";
import { initTracker, updateEKF } from "../build/debug.js";

function maxSessionZScore(domainId, vectors) {
  initTracker(domainId);
  let maxZ = 0;
  for (const [z0, z1, z2] of vectors) {
    const zScore = updateEKF(domainId, z0, z1, z2);
    maxZ = Math.max(maxZ, zScore);
  }
  return maxZ;
}

it("shadow harness: computes stable TPR/FPR over synthetic sessions", () => {
  const benignSessions = [
    [[0.05, 0.05, 0.05], [0.08, 0.1, 0.05], [0.07, 0.09, 0.06], [0.1, 0.1, 0.08]],
    [[0.1, 0.1, 0.1], [0.12, 0.12, 0.1], [0.15, 0.11, 0.1], [0.14, 0.12, 0.09]],
    [[0.08, 0.06, 0.05], [0.07, 0.08, 0.04], [0.1, 0.09, 0.06], [0.09, 0.1, 0.05]],
    [[0.1, 0.2, 0.1], [0.15, 0.25, 0.1], [0.12, 0.22, 0.12], [0.11, 0.2, 0.1]]
  ];

  const maliciousSessions = [
    [[0.1, 0.1, 0.1], [0.75, 0.9, 0.65], [0.8, 0.95, 0.7], [0.85, 0.92, 0.72]],
    [[0.05, 0.05, 0.05], [0.7, 0.8, 0.6], [0.82, 0.88, 0.7], [0.86, 0.9, 0.75]],
    [[0.1, 0.1, 0.1], [0.68, 0.86, 0.62], [0.79, 0.89, 0.66], [0.83, 0.91, 0.7]],
    [[0.05, 0.1, 0.05], [0.72, 0.85, 0.64], [0.81, 0.9, 0.71], [0.88, 0.93, 0.77]]
  ];

  let tp = 0, fp = 0, tn = 0, fn = 0;
  let id = 1000;
  const benignScores = [];
  const maliciousScores = [];

  for (const session of benignSessions) {
    benignScores.push(maxSessionZScore(id++, session));
  }
  for (const session of maliciousSessions) {
    maliciousScores.push(maxSessionZScore(id++, session));
  }

  const benignMean = benignScores.reduce((a, b) => a + b, 0) / benignScores.length;
  const maliciousMean = maliciousScores.reduce((a, b) => a + b, 0) / maliciousScores.length;
  const decisionThreshold = (benignMean + maliciousMean) / 2;

  for (const score of benignScores) {
    const predictedMalicious = score >= decisionThreshold;
    if (predictedMalicious) fp += 1; else tn += 1;
  }
  for (const score of maliciousScores) {
    const predictedMalicious = score >= decisionThreshold;
    if (predictedMalicious) tp += 1; else fn += 1;
  }

  const tpr = tp / (tp + fn || 1);
  const fpr = fp / (fp + tn || 1);

  assert.equal(maliciousMean > benignMean, true, "malicious mean should exceed benign mean");
  assert.equal(tpr >= 0.75, true, `TPR too low: ${tpr.toFixed(2)}`);
  assert.equal(fpr <= 0.25, true, `FPR too high: ${fpr.toFixed(2)}`);
});
