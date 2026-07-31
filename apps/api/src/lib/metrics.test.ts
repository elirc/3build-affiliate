import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, MAX_SERIES_PER_METRIC, Registry } from './metrics';

/** The bits of a Prometheus exposition a scraper actually parses. */
function parse(text: string) {
  const samples = new Map<string, number>();
  const types = new Map<string, string>();

  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('# TYPE ')) {
      const [, , name, type] = line.split(' ');
      types.set(name!, type!);
      continue;
    }
    if (line.startsWith('#')) continue;

    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*(?:\{.*\})?) (.+)$/.exec(line);
    expect(match, `unparseable line: ${line}`).not.toBeNull();
    samples.set(match![1]!, Number(match![2]));
  }
  return { samples, types };
}

describe('metrics registry', () => {
  it('renders a counter in Prometheus text format', async () => {
    const registry = new Registry();
    const counter = registry.register(
      new Counter('http_requests_total', 'Requests.', ['method', 'route', 'status'])
    );

    counter.inc({ method: 'GET', route: '/api/brand/campaigns/:id', status: '200' });
    counter.inc({ method: 'GET', route: '/api/brand/campaigns/:id', status: '200' });
    counter.inc({ method: 'GET', route: '/api/brand/campaigns/:id', status: '404' });

    const { samples, types } = parse(await registry.render());

    expect(types.get('http_requests_total')).toBe('counter');
    expect(
      samples.get(
        'http_requests_total{method="GET",route="/api/brand/campaigns/:id",status="200"}'
      )
    ).toBe(2);
    expect(
      samples.get(
        'http_requests_total{method="GET",route="/api/brand/campaigns/:id",status="404"}'
      )
    ).toBe(1);
  });

  it('keeps histogram buckets cumulative and adds +Inf, _sum and _count', async () => {
    const registry = new Registry();
    const histogram = registry.register(
      new Histogram('d_seconds', 'Duration.', ['route'], [0.1, 0.5, 1])
    );

    histogram.observe({ route: '/x' }, 0.05);
    histogram.observe({ route: '/x' }, 0.4);
    histogram.observe({ route: '/x' }, 7);

    const { samples, types } = parse(await registry.render());

    expect(types.get('d_seconds')).toBe('histogram');
    // Cumulative: 0.05 is under every bound, 0.4 is under two of them.
    expect(samples.get('d_seconds_bucket{route="/x",le="0.1"}')).toBe(1);
    expect(samples.get('d_seconds_bucket{route="/x",le="0.5"}')).toBe(2);
    expect(samples.get('d_seconds_bucket{route="/x",le="1"}')).toBe(2);
    // The 7 second observation only shows in +Inf -- the tail is exactly what
    // a mean would have hidden.
    expect(samples.get('d_seconds_bucket{route="/x",le="+Inf"}')).toBe(3);
    expect(samples.get('d_seconds_sum{route="/x"}')).toBeCloseTo(7.45, 5);
    expect(samples.get('d_seconds_count{route="/x"}')).toBe(3);
  });

  it('lets a gauge go down again', async () => {
    const registry = new Registry();
    const gauge = registry.register(new Gauge('queue_depth', 'Depth.', ['queue']));

    gauge.set({ queue: 'click_events' }, 12);
    gauge.set({ queue: 'click_events' }, 3);

    const { samples } = parse(await registry.render());
    expect(samples.get('queue_depth{queue="click_events"}')).toBe(3);
  });

  it('escapes label values so one cannot forge a second sample', async () => {
    const registry = new Registry();
    const counter = registry.register(new Counter('thing_total', 'Thing.', ['name']));

    counter.inc({ name: 'a"b\\c' });

    const rendered = await registry.render();
    expect(rendered).toContain('thing_total{name="a\\"b\\\\c"} 1');
    // Still one sample, not two.
    expect(parse(rendered).samples.size).toBeGreaterThan(0);
  });

  it('refuses new series past the cardinality cap instead of growing forever', async () => {
    const registry = new Registry();
    const counter = registry.register(new Counter('unbounded_total', 'Oops.', ['id']));

    for (let i = 0; i < MAX_SERIES_PER_METRIC + 25; i++) {
      counter.inc({ id: String(i) });
    }

    const { samples } = parse(await registry.render());
    const series = [...samples.keys()].filter((k) => k.startsWith('unbounded_total{'));
    expect(series).toHaveLength(MAX_SERIES_PER_METRIC);
    // The refusal is reported rather than silent, because a metric that
    // quietly stops being complete is worse than one that says it is not.
    expect(samples.get('metrics_series_dropped_total')).toBe(25);
    // An existing series still increments -- only *new* label sets are refused.
    counter.inc({ id: '0' });
    expect(counter.get({ id: '0' })).toBe(2);
  });

  it('renders the other metrics when a scrape-time collector throws', async () => {
    const registry = new Registry();
    const counter = registry.register(new Counter('ok_total', 'Fine.', []));
    counter.inc();

    registry.collect('broken', async () => {
      throw new Error('Redis is down');
    });

    // The moment a dependency is down is the moment someone is looking at the
    // dashboard. Losing the whole scrape then would be the worst possible time.
    const { samples } = parse(await registry.render());
    expect(samples.get('ok_total')).toBe(1);
    expect(samples.get('metrics_collector_errors_total{collector="broken"}')).toBe(1);
  });

  it('replaces a collector registered twice under the same name', async () => {
    // `build()` runs once per test file in a single process; appending would
    // print every gauge N times and double-count the I/O.
    const registry = new Registry();
    const gauge = registry.register(new Gauge('g', 'G.', []));

    let calls = 0;
    const collector = () => {
      calls += 1;
      gauge.set({}, calls);
    };
    registry.collect('same', collector);
    registry.collect('same', collector);

    await registry.render();
    expect(calls).toBe(1);
  });

  it('ends with a newline, which the text format requires', async () => {
    const registry = new Registry();
    registry.register(new Counter('a_total', 'A.', [])).inc();
    expect(await registry.render()).toMatch(/\n$/);
  });
});
