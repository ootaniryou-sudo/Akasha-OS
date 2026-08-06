#!/usr/bin/env bash
# Akasha-OS PoC Measurement Suite
# ───────────────────────────────
# Run on the master PC.  Requires: iperf3, curl, node (for WebTransport test)
#
# Usage:
#   chmod +x poc/measure.sh
#   ./poc/measure.sh <edge-ip-1> <edge-ip-2> ...

set -euo pipefail

MASTER_PORT=${AKASHA_PORT:-8080}
METRICS_PORT=${AKASHA_METRICS_PORT:-9090}
RESULTS_DIR="poc/results/$(date +%Y%m%d_%H%M%S)"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <edge-ip-1> [edge-ip-2] ..."
  echo "  Performs RTT, throughput, and WebTransport latency measurements."
  exit 1
fi

EDGES=("$@")
mkdir -p "$RESULTS_DIR"

echo "══════════════════════════════════════════════"
echo " Akasha-OS PoC Measurement Suite"
echo " Edges: ${EDGES[*]}"
echo " Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════"
echo ""

# ─── 1. ICMP RTT (baseline) ──────────────────────────────────────────────

echo "── 1. ICMP Ping RTT ──"
for ip in "${EDGES[@]}"; do
  ping -c 20 -i 0.2 "$ip" | tee "$RESULTS_DIR/ping_${ip//./_}.txt" | tail -1
done

# ─── 2. TCP throughput (iperf3) ───────────────────────────────────────────
# Edge must run: iperf3 -s

echo ""
echo "── 2. iperf3 TCP Throughput ──"
for ip in "${EDGES[@]}"; do
  echo "  Testing $ip ..."
  iperf3 -c "$ip" -t 10 -J > "$RESULTS_DIR/iperf3_${ip//./_}.json" 2>/dev/null || echo "  ⚠ iperf3 failed for $ip (is iperf3 -s running on edge?)"
done

# ─── 3. HTTP/3 (QUIC) reachability ────────────────────────────────────────

echo ""
echo "── 3. QUIC/HTTP3 Reachability ──"
# Check if the master is serving HTTP/3
HTTP3_OK=$(curl -sS -o /dev/null -w "%{http_version}" --http3-only "https://localhost:${MASTER_PORT}/" 2>/dev/null || echo "N/A")
echo "  Master HTTP/3: $HTTP3_OK"

# ─── 4. WebTransport datagram RTT (via node script) ───────────────────────

echo ""
echo "── 4. WebTransport Datagram RTT ──"
node poc/wt-rtt-measure.mjs "${EDGES[0]}" "$MASTER_PORT" 2>&1 | tee "$RESULTS_DIR/wt_rtt.txt"

# ─── 5. Prometheus metrics snapshot ────────────────────────────────────────

echo ""
echo "── 5. Metrics Snapshot ──"
curl -sS "http://localhost:${METRICS_PORT}/metrics" > "$RESULTS_DIR/metrics.txt" 2>/dev/null || echo "  ⚠ Metrics endpoint not reachable"

# ─── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════"
echo " Measurements complete."
echo " Results saved to: $RESULTS_DIR"
echo ""
echo " Quick analysis:"
for ip in "${EDGES[@]}"; do
  AVG_RTT=$(grep avg "$RESULTS_DIR/ping_${ip//./_}.txt" 2>/dev/null | awk -F'/' '{print $5}' || echo "N/A")
  echo "  $ip → avg RTT: ${AVG_RTT}ms"
done
echo "══════════════════════════════════════════════"
