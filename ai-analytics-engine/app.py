import json
import os
import threading
import time
from collections import deque
from datetime import datetime, timezone

import anthropic
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
if API_KEY.startswith("your-"):
    API_KEY = ""
GATEWAY_URL = os.getenv("GATEWAY_URL", "http://localhost:9090").rstrip("/")
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL_SECONDS", "2"))
RCA_COOLDOWN = float(os.getenv("RCA_COOLDOWN_SECONDS", "30"))
PORT = int(os.getenv("PORT", "5000"))

LEVELS = {"DEBUG", "INFO", "WARN", "ERROR", "FATAL"}
SEVERITIES = {"low", "medium", "high", "critical"}

client = anthropic.Anthropic(api_key=API_KEY, timeout=45.0) if API_KEY else None

app = Flask(__name__)
CORS(app)

lock = threading.RLock()
history = deque(maxlen=60)
log_buffer = deque(maxlen=200)
incidents = deque(maxlen=15)
state = {
    "gateway_online": False,
    "latest": None,
    "analysis": None,
    "rca_running": False,
    "last_rca_ts": 0.0,
    "gateway_error_logged": False,
}

SYSTEM_PROMPT = (
    "You are AstroPulse, a senior Site Reliability Engineer AI that performs Root Cause "
    "Analysis (RCA) for a cloud-native microservice platform running on Kubernetes with "
    "a PostgreSQL primary database. You receive the current telemetry snapshot, recent "
    "telemetry history and recent log lines. Reason from the evidence only. "
    "Respond with exactly ONE JSON object and nothing else: no markdown fences, no prose "
    "before or after. Use exactly these keys: "
    "summary (string, one or two sentences), "
    "root_cause (string, the most likely underlying cause), "
    "severity (one of low, medium, high, critical), "
    "confidence (integer from 0 to 100), "
    "affected_components (array of short strings), "
    "remediation_steps (array of 3 to 6 concise imperative strings, ordered by priority), "
    "prevention (string, one sentence on how to stop this recurring)."
)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def add_log(level, source, message):
    with lock:
        log_buffer.append(
            {"ts": utc_now(), "level": level, "source": source, "message": message}
        )


def parse_log_line(line):
    text = str(line).strip()
    parts = text.split(None, 2)
    if len(parts) == 3 and parts[0].upper() in LEVELS:
        return parts[0].upper(), parts[1], parts[2]
    if len(parts) >= 1 and parts[0].upper() in LEVELS:
        return parts[0].upper(), "gateway", " ".join(parts[1:])
    return "INFO", "gateway", text


def extract_json(text):
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("model response did not contain a JSON object")
    return json.loads(text[start : end + 1])


def as_list(value):
    if isinstance(value, list):
        return [str(item) for item in value]
    if value in (None, ""):
        return []
    return [str(value)]


def normalize_analysis(raw):
    severity = str(raw.get("severity", "high")).lower()
    if severity not in SEVERITIES:
        severity = "high"
    try:
        confidence = int(float(raw.get("confidence", 70)))
    except (TypeError, ValueError):
        confidence = 70
    confidence = max(0, min(100, confidence))
    return {
        "summary": str(raw.get("summary", "Anomalous system behaviour detected.")),
        "root_cause": str(raw.get("root_cause", "Undetermined")),
        "severity": severity,
        "confidence": confidence,
        "affected_components": as_list(raw.get("affected_components")),
        "remediation_steps": as_list(raw.get("remediation_steps")),
        "prevention": str(raw.get("prevention", "")),
    }


def heuristic_rca(metrics, logs):
    cpu = float(metrics.get("cpu_usage", 0) or 0)
    mem = float(metrics.get("memory_usage", 0) or 0)
    latency = float(metrics.get("latency_ms", 0) or 0)
    errors = float(metrics.get("error_rate", 0) or 0)
    db = float(metrics.get("db_pool_usage", 0) or 0)

    hot = sum([cpu > 85, mem > 85, db > 90])
    if hot >= 2:
        root = "Resource exhaustion is cascading across compute, memory and the database tier."
        components = ["order-service", "pricing-service", "payments-service", "postgres-primary"]
        steps = [
            "Shed non-critical traffic at the gateway and enable rate limiting",
            "Scale out stateless services and raise pod memory limits",
            "Fail over or restart the database primary after checking replication state",
            "Roll back the most recent deployment if it correlates with the onset",
        ]
        severity = "critical"
    elif mem > 85:
        root = "Memory pressure consistent with a leak or unbounded cache growth in a service."
        components = ["order-service", "kubelet"]
        steps = [
            "Capture a heap dump before restarting the affected pods",
            "Restart pods with a rolling strategy to restore headroom",
            "Add an eviction policy and size limit to in-memory caches",
        ]
        severity = "high"
    elif cpu > 85:
        root = "CPU saturation, most likely from an expensive computation or runaway batch job."
        components = ["pricing-service", "node pool"]
        steps = [
            "Identify the hottest threads with a CPU profile",
            "Pause or throttle batch jobs sharing the node",
            "Increase node capacity or autoscaler limits",
        ]
        severity = "high"
    elif db > 90 or latency > 500:
        root = "Database connection pool exhaustion driving high latency and request errors."
        components = ["payments-service", "postgres-primary"]
        steps = [
            "Inspect blocked sessions and terminate long-running locks",
            "Add the missing index for the slow query",
            "Raise pool size cautiously and add connection timeouts",
        ]
        severity = "high"
    else:
        root = "Metrics are elevated but no single dominant cause is visible in the data."
        components = ["astropulse-core"]
        steps = [
            "Compare against the last deployment and configuration change",
            "Continue monitoring for another few minutes",
            "Inspect service logs for repeating error signatures",
        ]
        severity = "medium"

    return {
        "summary": "Rule-based analysis (no Anthropic API key configured): " + root,
        "root_cause": root,
        "severity": severity,
        "confidence": 55,
        "affected_components": components,
        "remediation_steps": steps,
        "prevention": "Add saturation alerts and load tests that cover this failure mode.",
    }


def run_rca(metrics, logs, trigger):
    started = time.time()
    source = "heuristic-fallback"
    error_text = None

    if client is not None:
        context = {
            "trigger": trigger,
            "current_metrics": metrics,
            "recent_metrics": list(history)[-10:],
            "recent_logs": logs[-25:],
        }
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=1200,
                system=SYSTEM_PROMPT,
                messages=[
                    {
                        "role": "user",
                        "content": "Perform root cause analysis on this system state:\n"
                        + json.dumps(context, indent=2),
                    }
                ],
            )
            text = "".join(
                block.text for block in response.content if getattr(block, "type", "") == "text"
            )
            analysis = normalize_analysis(extract_json(text))
            source = "claude"
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc)
            analysis = normalize_analysis(heuristic_rca(metrics, logs))
            add_log("ERROR", "analytics-engine", "Claude RCA failed, using fallback: " + error_text)
    else:
        analysis = normalize_analysis(heuristic_rca(metrics, logs))

    analysis.update(
        {
            "source": source,
            "model": MODEL if source == "claude" else None,
            "trigger": trigger,
            "generated_at": utc_now(),
            "duration_ms": int((time.time() - started) * 1000),
            "metrics_status": metrics.get("status"),
            "active": True,
            "error": error_text,
        }
    )
    return analysis


def store_analysis(analysis):
    with lock:
        state["analysis"] = analysis
        state["last_rca_ts"] = time.time()
        incidents.appendleft(
            {
                "generated_at": analysis["generated_at"],
                "severity": analysis["severity"],
                "summary": analysis["summary"],
                "trigger": analysis["trigger"],
                "source": analysis["source"],
            }
        )
    add_log(
        "INFO",
        "analytics-engine",
        "RCA complete via " + analysis["source"] + " severity=" + analysis["severity"],
    )


def auto_rca_worker(metrics, logs):
    try:
        analysis = run_rca(metrics, logs, "auto-detected")
        store_analysis(analysis)
    finally:
        with lock:
            state["rca_running"] = False
            state["last_rca_ts"] = time.time()


def maybe_auto_rca(metrics):
    with lock:
        if state["rca_running"]:
            return
        if time.time() - state["last_rca_ts"] < RCA_COOLDOWN:
            return
        state["rca_running"] = True
        logs = [
            entry["level"] + " " + entry["source"] + " " + entry["message"]
            for entry in list(log_buffer)[-25:]
        ]
    threading.Thread(target=auto_rca_worker, args=(dict(metrics), logs), daemon=True).start()


def ingest(metrics):
    metrics = dict(metrics)
    metrics["received_at"] = utc_now()
    status = metrics.get("status", "healthy")

    with lock:
        history.append(metrics)
        state["latest"] = metrics
        state["gateway_online"] = True
        state["gateway_error_logged"] = False
        recovered = status == "healthy" and state["analysis"] and state["analysis"].get("active")
        if recovered:
            state["analysis"]["active"] = False

    line = (
        "cpu={cpu}% mem={mem}% p95={lat}ms err={err}% db={db}%".format(
            cpu=metrics.get("cpu_usage"),
            mem=metrics.get("memory_usage"),
            lat=metrics.get("latency_ms"),
            err=metrics.get("error_rate"),
            db=metrics.get("db_pool_usage"),
        )
    )
    if status == "critical":
        add_log("ERROR", "telemetry", "CRITICAL " + line)
    elif status == "degraded":
        add_log("WARN", "telemetry", "DEGRADED " + line)
    else:
        add_log("INFO", "telemetry", line)

    if recovered:
        add_log("INFO", "analytics-engine", "System recovered, incident marked resolved")

    if status != "healthy":
        maybe_auto_rca(metrics)


def poll_loop():
    while True:
        try:
            response = requests.get(GATEWAY_URL + "/api/telemetry", timeout=5)
            response.raise_for_status()
            ingest(response.json())
        except Exception as exc:  # noqa: BLE001
            with lock:
                state["gateway_online"] = False
                already_logged = state["gateway_error_logged"]
                state["gateway_error_logged"] = True
            if not already_logged:
                add_log("ERROR", "analytics-engine", "Gateway unreachable at " + GATEWAY_URL + ": " + str(exc))
        time.sleep(POLL_INTERVAL)


@app.get("/health")
def health():
    return jsonify(
        {
            "status": "UP",
            "service": "astropulse-analytics-engine",
            "ai_enabled": client is not None,
            "model": MODEL,
        }
    )


@app.get("/api/metrics")
def api_metrics():
    with lock:
        payload = {
            "server_time": utc_now(),
            "gateway_online": state["gateway_online"],
            "ai_enabled": client is not None,
            "model": MODEL,
            "rca_running": state["rca_running"],
            "latest": state["latest"],
            "history": list(history),
            "analysis": state["analysis"],
            "incidents": list(incidents),
            "logs": list(log_buffer)[-40:],
        }
    return jsonify(payload)


@app.post("/analyze")
def analyze():
    payload = request.get_json(silent=True) or {}
    metrics = payload.get("metrics") or {}
    raw_logs = payload.get("logs") or []
    force = bool(payload.get("force"))
    trigger = str(payload.get("trigger") or payload.get("source") or "gateway")

    if not isinstance(raw_logs, list):
        raw_logs = [raw_logs]
    for line in raw_logs:
        level, source, message = parse_log_line(line)
        add_log(level, source, message)

    if not force and metrics.get("status", "healthy") == "healthy":
        return jsonify({"status": "nominal", "message": "No anomaly detected, analysis skipped"})

    with lock:
        if state["rca_running"] and not force:
            return jsonify({"status": "busy", "analysis": state["analysis"]}), 202
        state["rca_running"] = True

    try:
        logs = [str(line) for line in raw_logs]
        recent = [
            entry["level"] + " " + entry["source"] + " " + entry["message"]
            for entry in list(log_buffer)[-10:]
        ]
        analysis = run_rca(metrics, logs + recent, trigger)
        store_analysis(analysis)
    finally:
        with lock:
            state["rca_running"] = False
            state["last_rca_ts"] = time.time()

    return jsonify(analysis)


def start_poller():
    thread = threading.Thread(target=poll_loop, daemon=True, name="gateway-poller")
    thread.start()


if __name__ == "__main__":
    if client is None:
        add_log("WARN", "analytics-engine", "ANTHROPIC_API_KEY not set, using rule-based fallback RCA")
    else:
        add_log("INFO", "analytics-engine", "Claude RCA enabled with model " + MODEL)
    start_poller()
    print("AstroPulse analytics engine listening on http://localhost:" + str(PORT))
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True, use_reloader=False)
