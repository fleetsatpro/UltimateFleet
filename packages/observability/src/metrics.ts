/**
 * A minimal in-process metrics registry.
 *
 * Deliberately not Prometheus-client yet: the observability backend the team runs is
 * an open item (open item 8), and committing to an exposition format before knowing
 * the destination is how you end up maintaining two. This interface is what the rest
 * of the system codes against, so swapping the implementation later touches one file.
 */
export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  counter(name: string, value?: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  histogram(name: string, value: number, labels?: MetricLabels): void;
  snapshot(): readonly MetricSample[];
}

export interface MetricSample {
  readonly name: string;
  readonly kind: 'counter' | 'gauge' | 'histogram';
  readonly labels: MetricLabels;
  readonly value: number;
  readonly count: number;
}

function keyOf(name: string, labels: MetricLabels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}

export function createMetrics(): Metrics {
  const samples = new Map<string, { sample: MetricSample }>();

  const upsert = (
    kind: MetricSample['kind'],
    name: string,
    value: number,
    labels: MetricLabels,
    accumulate: boolean,
  ): void => {
    const key = keyOf(name, labels);
    const existing = samples.get(key);
    if (existing === undefined) {
      samples.set(key, { sample: { name, kind, labels, value, count: 1 } });
      return;
    }
    const previous = existing.sample;
    samples.set(key, {
      sample: {
        name,
        kind,
        labels,
        value: accumulate ? previous.value + value : value,
        count: previous.count + 1,
      },
    });
  };

  return {
    counter(name, value = 1, labels = {}) {
      upsert('counter', name, value, labels, true);
    },
    gauge(name, value, labels = {}) {
      upsert('gauge', name, value, labels, false);
    },
    histogram(name, value, labels = {}) {
      // Sum plus count; percentile computation belongs in the backend, not here.
      upsert('histogram', name, value, labels, true);
    },
    snapshot() {
      return [...samples.values()].map((entry) => entry.sample);
    },
  };
}
