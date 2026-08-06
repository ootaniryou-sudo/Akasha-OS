#!/usr/bin/env bash
# Edge device setup script for Akasha-OS PoC
# ────────────────────────────────────────────
# Run this on each Android edge device (via Termux or adb shell).
# Performs: network interface check, connectivity test, iperf3 server start.
#
# Prerequisites (Android/Termux):
#   pkg install iperf3 curl iproute2

set -euo pipefail

echo "══════════════════════════════════════════════"
echo " Akasha-OS Edge Setup"
echo "══════════════════════════════════════════════"

# ─── 1. Network interface check ──────────────────────────────────────────

echo ""
echo "── 1. Network Interfaces ──"
if command -v ip &>/dev/null; then
  ip addr show | grep -E "eth|wlan|usb" || echo "  No wired interface detected"
else
  ifconfig 2>/dev/null | grep -E "eth|wlan|usb" || echo "  ifconfig not available"
fi

# ─── 2. Check for Ethernet (USB-LAN adapter) ─────────────────────────────

echo ""
echo "── 2. Ethernet Detection ──"
ETH_IFACE=$(ip link show 2>/dev/null | grep -E "^[0-9]+: (eth|enp)" | head -1 | awk -F': ' '{print $2}' || echo "")
if [ -n "$ETH_IFACE" ]; then
  echo "  ✅ Ethernet detected: $ETH_IFACE"
  ETH_IP=$(ip addr show "$ETH_IFACE" 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
  echo "  IP: $ETH_IP"
else
  echo "  ⚠ No Ethernet interface found. Connect USB-LAN adapter."
  echo "  Supported adapters: ASIX AX88179, Realtek RTL8153, etc."
fi

# ─── 3. Check WebGPU support (via Chrome) ─────────────────────────────────

echo ""
echo "── 3. WebGPU Check ──"
echo "  Open chrome://gpu in Chrome and verify:"
echo "    - WebGPU: Software only / Hardware accelerated"
echo "    - Vulkan: Enabled"

# ─── 4. Start iperf3 server ──────────────────────────────────────────────

echo ""
echo "── 4. iperf3 Server ──"
if command -v iperf3 &>/dev/null; then
  echo "  Starting iperf3 server on port 5201..."
  iperf3 -s -D
  echo "  ✅ iperf3 running (daemonized)"
else
  echo "  ⚠ iperf3 not installed. Run: pkg install iperf3"
fi

echo ""
echo "══════════════════════════════════════════════"
echo " Edge setup complete."
echo ""
echo " Next steps on master PC:"
echo "   ./poc/measure.sh <this-device-ip>"
echo "══════════════════════════════════════════════"
