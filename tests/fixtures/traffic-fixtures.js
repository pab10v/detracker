export const benignTrafficFixtures = [
  { page: "news.example", vectors: [[0.05, 0.05, 0.05], [0.08, 0.1, 0.05], [0.1, 0.1, 0.08]] },
  { page: "docs.example", vectors: [[0.1, 0.1, 0.1], [0.12, 0.12, 0.1], [0.11, 0.1, 0.09]] }
];

export const maliciousTrafficFixtures = [
  { page: "movie.example", vectors: [[0.1, 0.1, 0.1], [0.75, 0.9, 0.65], [0.8, 0.95, 0.7]] },
  { page: "stream.example", vectors: [[0.05, 0.05, 0.05], [0.7, 0.8, 0.6], [0.82, 0.88, 0.7]] }
];
