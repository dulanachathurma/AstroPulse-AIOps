import ballerina/http;
import ballerina/log;
import ballerina/random;
import ballerina/time;

configurable string analyticsUrl = "http://localhost:5000";
configurable int anomalyDurationTicks = 20;

final http:Client analyticsClient = check new (analyticsUrl, timeout = 60);

string activeAnomaly = "none";
int remainingTicks = 0;

type TriggerRequest record {
    string mode = "cascade";
};

function rnd() returns float {
    return <float>random:createDecimal();
}

function round1(float value) returns float {
    return <float>(<int>(value * 10.0)) / 10.0;
}

function classify(float cpu, float mem, float latency, float errors, float db) returns string {
    if cpu > 85.0 || mem > 85.0 || latency > 500.0 || errors > 5.0 || db > 90.0 {
        return "critical";
    }
    if cpu > 65.0 || mem > 70.0 || latency > 250.0 || errors > 2.0 || db > 75.0 {
        return "degraded";
    }
    return "healthy";
}

function buildTelemetry() returns map<json> {
    float cpu = 18.0 + rnd() * 14.0;
    float mem = 41.0 + rnd() * 8.0;
    float latency = 60.0 + rnd() * 40.0;
    float errors = rnd() * 0.6;
    float rps = 900.0 + rnd() * 200.0;
    float db = 30.0 + rnd() * 10.0;
    string mode = activeAnomaly;

    if remainingTicks > 0 {
        match mode {
            "memory_leak" => {
                mem = 86.0 + rnd() * 11.0;
                cpu += 20.0;
                latency = latency * 2.6;
                errors += 2.0 + rnd() * 2.0;
                rps = rps * 0.85;
            }
            "cpu_spike" => {
                cpu = 90.0 + rnd() * 9.0;
                latency = latency * 4.5;
                errors += 1.0 + rnd() * 2.0;
                rps = rps * 0.7;
            }
            "db_latency" => {
                db = 92.0 + rnd() * 7.0;
                latency = 900.0 + rnd() * 1200.0;
                errors = 6.0 + rnd() * 6.0;
                rps = rps * 0.55;
                cpu += 8.0;
            }
            "cascade" => {
                cpu = 88.0 + rnd() * 11.0;
                mem = 87.0 + rnd() * 10.0;
                db = 93.0 + rnd() * 6.0;
                latency = 1500.0 + rnd() * 2000.0;
                errors = 9.0 + rnd() * 8.0;
                rps = rps * 0.35;
            }
            _ => {
            }
        }
        remainingTicks = remainingTicks - 1;
        if remainingTicks == 0 {
            activeAnomaly = "none";
        }
    }

    cpu = float:min(cpu, 99.9);
    mem = float:min(mem, 99.9);
    db = float:min(db, 99.9);
    errors = float:min(errors, 60.0);

    return {
        "timestamp": time:utcToString(time:utcNow()),
        "service": "astropulse-core",
        "cpu_usage": round1(cpu),
        "memory_usage": round1(mem),
        "latency_ms": round1(latency),
        "error_rate": round1(errors),
        "requests_per_sec": round1(rps),
        "db_pool_usage": round1(db),
        "status": classify(cpu, mem, latency, errors, db),
        "active_anomaly": mode
    };
}

function buildLogs(string mode) returns string[] {
    match mode {
        "memory_leak" => {
            return [
                "INFO  order-service     request rate nominal, 1042 rps",
                "WARN  heap-monitor      old-gen occupancy 91% after full GC, reclaimed only 2MB",
                "WARN  order-service     session cache grew to 4.8M entries, no eviction policy active",
                "ERROR order-service     java.lang.OutOfMemoryError: Java heap space (retry 3/5)",
                "ERROR kubelet           container order-service exceeded memory limit, restart count 4",
                "WARN  gateway           upstream order-service latency above SLO"
            ];
        }
        "cpu_spike" => {
            return [
                "INFO  scheduler         batch job reindex-catalog started",
                "WARN  node-exporter     cpu load 1m avg 14.2 on 8 cores",
                "WARN  pricing-service    regex evaluation exceeded 800ms on rule set v42",
                "ERROR pricing-service    request timeout after 3000ms, thread pool saturated",
                "ERROR gateway           circuit breaker OPEN for pricing-service",
                "WARN  hpa               scale-out blocked, cluster at max node capacity"
            ];
        }
        "db_latency" => {
            return [
                "INFO  payments-service  checkout flow started",
                "WARN  postgres-primary  slow query 2140ms: SELECT * FROM ledger WHERE account_id = ?",
                "WARN  payments-service  connection pool 97/100 in use, 41 waiters",
                "ERROR payments-service  could not acquire connection within 5000ms",
                "ERROR postgres-primary  lock wait timeout on relation ledger, 12 blocked sessions",
                "WARN  gateway           5xx ratio 9.4% on /payments"
            ];
        }
        "cascade" => {
            return [
                "ERROR postgres-primary  replication lag 48s, replica marked unhealthy",
                "ERROR payments-service  connection pool exhausted 100/100",
                "ERROR order-service     OutOfMemoryError while buffering failed payment retries",
                "ERROR pricing-service    cpu throttled, p99 latency 6200ms",
                "FATAL gateway           circuit breakers OPEN for 3 of 4 upstream services",
                "ERROR kubelet           evicting pods under node memory pressure",
                "WARN  hpa               scale-out failed, insufficient cpu in cluster"
            ];
        }
        _ => {
            return [
                "INFO  gateway           anomaly injection requested with unknown mode"
            ];
        }
    }
}

@http:ServiceConfig {
    cors: {
        allowOrigins: ["*"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        maxAge: 84900
    }
}
service /api on new http:Listener(9090) {

    resource function get health() returns json {
        json result = {
            "status": "UP",
            "service": "astropulse-gateway",
            "activeAnomaly": activeAnomaly,
            "remainingTicks": remainingTicks
        };
        return result;
    }

    resource function get telemetry() returns json {
        map<json> telemetry = buildTelemetry();
        json result = telemetry;
        return result;
    }

    resource function post trigger\-anomaly(@http:Payload TriggerRequest req) returns json|http:BadRequest {
        string mode = req.mode;

        if mode == "none" {
            activeAnomaly = "none";
            remainingTicks = 0;
            json cleared = {
                "status": "cleared",
                "mode": "none"
            };
            return cleared;
        }

        if mode != "memory_leak" && mode != "cpu_spike" && mode != "db_latency" && mode != "cascade" {
            http:BadRequest bad = {
                body: {
                    "error": "unknown anomaly mode",
                    "supported": ["memory_leak", "cpu_spike", "db_latency", "cascade", "none"]
                }
            };
            return bad;
        }

        activeAnomaly = mode;
        remainingTicks = anomalyDurationTicks;
        map<json> snapshot = buildTelemetry();

        json payload = {
            "source": "ballerina-gateway",
            "trigger": mode,
            "force": true,
            "metrics": snapshot,
            "logs": buildLogs(mode)
        };

        json|error analysis = analyticsClient->post("/analyze", payload);
        if analysis is error {
            log:printError("Failed to forward logs to the AI analytics engine", 'error = analysis);
            json degraded = {
                "status": "triggered",
                "mode": mode,
                "durationTicks": anomalyDurationTicks,
                "analysis": (),
                "warning": "Anomaly injected, but the analytics engine on port 5000 could not be reached"
            };
            return degraded;
        }

        json ok = {
            "status": "triggered",
            "mode": mode,
            "durationTicks": anomalyDurationTicks,
            "analysis": analysis
        };
        return ok;
    }
}
