/**
 * Test stub for @pm2/io (see vitest.config.ts): @colyseus/core optionally
 * loads it for KeyMetrics metrics. Only `default.metric()` is used by core.
 */

const noopMetric = () => ({ set: () => {}, inc: () => {}, dec: () => {} });

const stub = {
  metric: noopMetric,
  counter: noopMetric,
  histogram: noopMetric,
  meter: noopMetric,
};

export default stub;
