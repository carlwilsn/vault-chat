// Render-only production-App regression probe. Install before navigation, then
// replay genuine captured worker progress through the ordinary backend/poll feed.
// Never enable this Fiber walk during keyboard latency measurements.
import assert from 'node:assert/strict';

export async function installWorkerRenderProbe(page) {
  await page.addInitScript(() => {
    window.__renders = { enabled: false, commits: 0, counts: {}, unrelatedHistoricalRenders: 0 };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject() { return 1; },
      onCommitFiberUnmount() {},
      onCommitFiberRoot(_id, root) {
        const r = window.__renders;
        if (!r.enabled) return;
        r.commits++;
        function walk(f) {
          if (!f) return;
          if ((f.flags & 1) && typeof f.type === 'function') {
            const p = f.memoizedProps || {};
            if (p.message?.role) {
              r.counts['historical-bubble'] = (r.counts['historical-bubble'] || 0) + 1;
              const old = f.alternate?.memoizedProps;
              // Real transcript/ask/voice changes are allowed. Empty worker-link
              // arrays and irrelevant available-worker IDs must not render a bubble.
              if (old && !p.spawns?.length && !old.spawns?.length &&
                  Object.keys(p).every(k => k === 'spawns' || k === 'openableThreadIds' || Object.is(p[k], old[k]))) {
                r.unrelatedHistoricalRenders = (r.unrelatedHistoricalRenders || 0) + 1;
              }
            }
          }
          if (!f.alternate || f.child !== f.alternate.child) {
            for (let child = f.child; child; child = child.sibling) walk(child);
          }
        }
        walk(root.current);
      },
    };
  });
}

export function assertWorkerRenderIsolation(sample) {
  assert(sample.commits > 0, 'probe must observe real worker-update commits');
  assert(sample.counts['historical-bubble'] > 0, 'live worker bubbles must still update');
  assert.equal(sample.unrelatedHistoricalRenders || 0, 0,
    'worker progress rerendered immutable history with no worker links');
}
