import { useCallback, useEffect, useRef, useState } from "react";

const ANALYTICS_URL = import.meta.env.VITE_ANALYTICS_URL || "http://localhost:5000";
const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "http://localhost:9090";
const POLL_MS = 2000;

const COLORS = {
  green: "#00ff9c",
  amber: "#ffb000",
  red: "#ff3b3b",
  cyan: "#22d3ee",
};

const METRICS = [
  { key: "cpu_usage", label: "CPU LOAD", unit: "%", warn: 65, crit: 85, max: 100, dec: 1 },
  { key: "memory_usage", label: "MEMORY", unit: "%", warn: 70, crit: 85, max: 100, dec: 1 },
  { key: "latency_ms", label: "P95 LATENCY", unit: "ms", warn: 250, crit: 500, max: 1000, dec: 0 },
  { key: "error_rate", label: "ERROR RATE", unit: "%", warn: 2, crit: 5, max: 12, dec: 1 },
  { key: "db_pool_usage", label: "DB POOL", unit: "%", warn: 75, crit: 90, max: 100, dec: 1 },
  { key: "requests_per_sec", label: "THROUGHPUT", unit: "rps", warn: null, crit: null, max: 1200, dec: 0 },
];

const SCENARIOS = [
  { mode: "memory_leak", label: "MEMORY LEAK", hint: "heap exhaustion in order-service" },
  { mode: "cpu_spike", label: "CPU SPIKE", hint: "runaway compute in pricing-service" },
  { mode: "db_latency", label: "DB LATENCY", hint: "pool exhaustion on postgres-primary" },
  { mode: "cascade", label: "CASCADE FAILURE", hint: "multi-service meltdown" },
];

const STATUS_STYLE = {
  healthy: { label: "ALL SYSTEMS NOMINAL", text: "text-neon-green", border: "border-neon-green/40", dot: "bg-neon-green" },
  degraded: { label: "DEGRADED PERFORMANCE", text: "text-neon-amber", border: "border-neon-amber/60", dot: "bg-neon-amber" },
  critical: { label: "CRITICAL INCIDENT", text: "text-neon-red", border: "border-neon-red/70 animate-pulseGlow", dot: "bg-neon-red" },
  no_gateway: { label: "GATEWAY UNREACHABLE", text: "text-neon-amber", border: "border-neon-amber/60", dot: "bg-neon-amber" },
  offline: { label: "ANALYTICS ENGINE OFFLINE", text: "text-neon-red", border: "border-neon-red/70", dot: "bg-neon-red" },
  booting: { label: "WAITING FOR TELEMETRY", text: "text-neon-cyan", border: "border-neon-cyan/40", dot: "bg-neon-cyan" },
};

const SEVERITY_TEXT = {
  low: "text-neon-cyan",
  medium: "text-neon-amber",
  high: "text-neon-pink",
  critical: "text-neon-red",
};

const LEVEL_TEXT = {
  DEBUG: "text-slate-500",
  INFO: "text-neon-green/80",
  WARN: "text-neon-amber",
  ERROR: "text-neon-red",
  FATAL: "text-neon-pink",
};

function metricLevel(value, metric) {
  if (metric.crit === null || value === undefined || value === null) return "ok";
  if (value >= metric.crit) return "crit";
  if (value >= metric.warn) return "warn";
  return "ok";
}

const LEVEL_CLASS = { ok: "text-neon-green", warn: "text-neon-amber", crit: "text-neon-red" };
const LEVEL_STROKE = { ok: COLORS.green, warn: COLORS.amber, crit: COLORS.red };

function formatTime(iso) {
  if (!iso) return "--:--:--";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false });
}

function Sparkline({ data, max, stroke }) {
  if (data.length < 2) return <div className="h-10" />;
  const width = 100;
  const height = 32;
  const top = Math.max(max, ...data, 1);
  const points = data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * width;
      const y = height - 1 - (value / top) * (height - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-10 w-full" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Panel({ title, right, className = "", children }) {
  return (
    <section className={`panel ${className}`}>
      <header className="flex items-center justify-between border-b border-neon-green/20 px-4 py-2 text-xs tracking-widest text-neon-green/80">
        <span>{`> ${title}`}</span>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MetricCard({ metric, latest, history }) {
  const value = latest ? latest[metric.key] : undefined;
  const level = metricLevel(value, metric);
  const series = history.map((entry) => entry[metric.key] ?? 0);
  const stroke = metric.crit === null ? COLORS.cyan : LEVEL_STROKE[level];
  const textClass = metric.crit === null ? "text-neon-cyan" : LEVEL_CLASS[level];
  return (
    <div className="panel p-4">
      <div className="flex items-baseline justify-between text-xs tracking-widest text-neon-green/60">
        <span>{metric.label}</span>
        <span>{metric.crit !== null ? `crit ${metric.crit}${metric.unit}` : "info"}</span>
      </div>
      <div className={`mt-2 text-3xl font-bold ${textClass}`}>
        {value === undefined || value === null ? "--" : Number(value).toFixed(metric.dec)}
        <span className="ml-1 text-sm font-normal opacity-70">{metric.unit}</span>
      </div>
      <div className="mt-2">
        <Sparkline data={series} max={metric.max} stroke={stroke} />
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [clock, setClock] = useState(new Date());
  const logRef = useRef(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await fetch(`${ANALYTICS_URL}/api/metrics`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json());
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, POLL_MS);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const logs = data?.logs ?? [];
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.length, logs[logs.length - 1]?.ts]);

  const trigger = async (mode) => {
    setBusy(mode);
    setNotice(null);
    try {
      const response = await fetch(`${GATEWAY_URL}/api/trigger-anomaly`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) throw new Error(`Gateway responded with HTTP ${response.status}`);
      const result = await response.json();
      if (result.warning) {
        setNotice({ kind: "warn", text: result.warning });
      } else if (mode === "none") {
        setNotice({ kind: "ok", text: "Anomaly cleared. Telemetry returns to baseline." });
      } else {
        setNotice({ kind: "ok", text: `Anomaly '${mode}' injected and forwarded for root cause analysis.` });
      }
      await fetchMetrics();
    } catch (error) {
      setNotice({
        kind: "error",
        text: `Could not reach the gateway on port 9090: ${error.message}. Start it with 'bal run' in ballerina-gateway.`,
      });
    } finally {
      setBusy(null);
    }
  };

  const latest = data?.latest ?? null;
  const history = data?.history ?? [];
  const analysis = data?.analysis ?? null;
  const incidents = data?.incidents ?? [];

  let statusKey = "booting";
  if (!online) statusKey = "offline";
  else if (!data?.gateway_online) statusKey = "no_gateway";
  else if (latest?.status) statusKey = latest.status;
  const status = STATUS_STYLE[statusKey] ?? STATUS_STYLE.booting;

  const noticeClass =
    notice?.kind === "error"
      ? "text-neon-red border-neon-red/50"
      : notice?.kind === "warn"
      ? "text-neon-amber border-neon-amber/50"
      : "text-neon-green border-neon-green/40";

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="glow-green text-2xl font-bold tracking-widest text-neon-green md:text-3xl">
            ASTROPULSE<span className="text-neon-pink">//</span>AIOPS
            <span className="ml-1 inline-block h-6 w-3 translate-y-1 bg-neon-green animate-blink" aria-hidden="true" />
          </h1>
          <p className="mt-1 text-xs tracking-widest text-neon-green/60">
            cloud-native integration and AI-driven system health gateway
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs tracking-widest">
          <span className={online ? "text-neon-green" : "text-neon-red"}>
            ENGINE:{online ? "ONLINE" : "OFFLINE"}
          </span>
          <span className={data?.gateway_online ? "text-neon-green" : "text-neon-amber"}>
            GATEWAY:{data?.gateway_online ? "ONLINE" : "OFFLINE"}
          </span>
          <span className={data?.ai_enabled ? "text-neon-cyan" : "text-neon-amber"}>
            AI:{data?.ai_enabled ? data.model : "FALLBACK"}
          </span>
          <span className="text-neon-green/70">{clock.toLocaleTimeString([], { hour12: false })}</span>
        </div>
      </header>

      <div className={`mb-6 flex items-center gap-3 border bg-void-panel/85 px-4 py-3 ${status.border}`}>
        <span className={`h-3 w-3 rounded-full ${status.dot}`} aria-hidden="true" />
        <span className={`text-sm font-bold tracking-widest ${status.text}`}>{status.label}</span>
        {latest?.active_anomaly && latest.active_anomaly !== "none" && (
          <span className="ml-auto text-xs tracking-widest text-neon-pink">
            injected: {latest.active_anomaly}
          </span>
        )}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {METRICS.map((metric) => (
          <MetricCard key={metric.key} metric={metric} latest={latest} history={history} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Panel title="anomaly injector">
            <div className="grid grid-cols-1 gap-2">
              {SCENARIOS.map((scenario) => (
                <button
                  key={scenario.mode}
                  type="button"
                  className="btn-neon"
                  disabled={busy !== null}
                  onClick={() => trigger(scenario.mode)}
                >
                  <span className="block font-bold">
                    {busy === scenario.mode ? "ANALYZING..." : `$ inject ${scenario.mode}`}
                  </span>
                  <span className="block text-[11px] tracking-normal opacity-70">{scenario.hint}</span>
                </button>
              ))}
              <button
                type="button"
                className="btn-neon border-neon-green/40 text-neon-green"
                disabled={busy !== null}
                onClick={() => trigger("none")}
              >
                <span className="block font-bold">$ clear anomaly</span>
                <span className="block text-[11px] tracking-normal opacity-70">return telemetry to baseline</span>
              </button>
            </div>
            {notice && (
              <p className={`mt-3 border px-3 py-2 text-xs ${noticeClass}`} role="status">
                {notice.text}
              </p>
            )}
          </Panel>

          <Panel
            title="live log stream"
            right={<span className="text-neon-green/50">{logs.length} lines</span>}
          >
            <div
              ref={logRef}
              className="terminal h-72 overflow-y-auto bg-black/60 p-3 text-xs leading-relaxed"
            >
              {logs.length === 0 && (
                <p className="text-neon-green/50">Waiting for log lines from the analytics engine...</p>
              )}
              {logs.map((entry, index) => (
                <div key={`${entry.ts}-${index}`} className="whitespace-pre-wrap break-words">
                  <span className="text-slate-500">{formatTime(entry.ts)} </span>
                  <span className={`${LEVEL_TEXT[entry.level] ?? "text-neon-green/80"} font-bold`}>
                    {entry.level.padEnd(5, " ")}
                  </span>
                  <span className="text-neon-cyan/80"> {entry.source} </span>
                  <span className="text-neon-green/90">{entry.message}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-3">
          <Panel
            title="root cause analysis"
            right={
              data?.rca_running ? (
                <span className="text-neon-amber">analyzing...</span>
              ) : analysis ? (
                <span className={analysis.active ? "text-neon-red" : "text-neon-green/60"}>
                  {analysis.active ? "active incident" : "resolved"}
                </span>
              ) : null
            }
          >
            {!analysis && (
              <p className="text-sm text-neon-green/60">
                No incident analysed yet. Inject an anomaly from the panel on the left, or wait for the
                engine to detect one in the telemetry stream.
              </p>
            )}
            {analysis && (
              <div className="space-y-4 text-sm">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs tracking-widest">
                  <span className={`font-bold ${SEVERITY_TEXT[analysis.severity] ?? "text-neon-amber"}`}>
                    SEVERITY {String(analysis.severity).toUpperCase()}
                  </span>
                  <span className="text-neon-cyan">CONFIDENCE {analysis.confidence}%</span>
                  <span className="text-neon-green/60">
                    {analysis.source === "claude" ? `claude / ${analysis.model}` : "rule-based fallback"}
                  </span>
                  <span className="text-neon-green/60">{formatTime(analysis.generated_at)}</span>
                  <span className="text-neon-green/60">{analysis.duration_ms} ms</span>
                </div>

                <div>
                  <h3 className="text-xs tracking-widest text-neon-pink">SUMMARY</h3>
                  <p className="mt-1 text-neon-green">{analysis.summary}</p>
                </div>

                <div>
                  <h3 className="text-xs tracking-widest text-neon-pink">ROOT CAUSE</h3>
                  <p className="mt-1 text-neon-green">{analysis.root_cause}</p>
                </div>

                <div>
                  <h3 className="text-xs tracking-widest text-neon-pink">AFFECTED COMPONENTS</h3>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {(analysis.affected_components ?? []).map((component) => (
                      <span
                        key={component}
                        className="border border-neon-cyan/40 px-2 py-0.5 text-xs text-neon-cyan"
                      >
                        {component}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs tracking-widest text-neon-pink">REMEDIATION</h3>
                  <ol className="mt-1 list-inside list-decimal space-y-1 text-neon-green">
                    {(analysis.remediation_steps ?? []).map((step, index) => (
                      <li key={`${index}-${step}`}>{step}</li>
                    ))}
                  </ol>
                </div>

                {analysis.prevention && (
                  <div>
                    <h3 className="text-xs tracking-widest text-neon-pink">PREVENTION</h3>
                    <p className="mt-1 text-neon-green/80">{analysis.prevention}</p>
                  </div>
                )}

                {analysis.error && (
                  <p className="border border-neon-amber/50 px-3 py-2 text-xs text-neon-amber">
                    Claude request failed, showing rule-based analysis instead: {analysis.error}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel title="incident history">
            {incidents.length === 0 ? (
              <p className="text-sm text-neon-green/60">No incidents recorded in this session.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {incidents.map((incident, index) => (
                  <li
                    key={`${incident.generated_at}-${index}`}
                    className="flex gap-3 border-b border-neon-green/10 pb-2"
                  >
                    <span className="shrink-0 text-slate-500">{formatTime(incident.generated_at)}</span>
                    <span
                      className={`w-16 shrink-0 font-bold ${SEVERITY_TEXT[incident.severity] ?? "text-neon-amber"}`}
                    >
                      {String(incident.severity).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-neon-green/90" title={incident.summary}>
                      {incident.summary}
                    </span>
                    <span className="shrink-0 text-neon-cyan/70">{incident.trigger}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <footer className="mt-8 text-center text-xs tracking-widest text-neon-green/40">
        polling {ANALYTICS_URL} every {POLL_MS / 1000}s | control plane {GATEWAY_URL}
      </footer>
    </div>
  );
}
