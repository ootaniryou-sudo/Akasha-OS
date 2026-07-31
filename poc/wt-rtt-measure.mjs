/**
 * poc/wt-rtt-measure.mjs
 *
 * Minimal WebTransport datagram RTT measurement client.
 * Connects to the Akasha master, sends timestamped datagrams,
 * and measures round-trip time in microseconds.
 *
 * Usage:
 *   node poc/wt-rtt-measure.mjs <master-ip> <port>
 *
 * Requires: Node.js >= 20 with --experimental-webtransport
 *           or a browser environment.
 */

const masterIp = process.argv[2] || '127.0.0.1';
const masterPort = parseInt(process.argv[3] || '8080', 10);
const NUM_PINGS = 50;
const PING_INTERVAL_MS = 20;

// Fletcher32 checksum (matches protocol.ts)
function fletcher32(data) {
  let sum1 = 0xffff, sum2 = 0xffff;
  for (let i = 0; i < data.length; i++) {
    sum1 = (sum1 + data[i]) % 65535;
    sum2 = (sum2 + sum1) % 65535;
  }
  return ((sum2 << 16) | sum1) >>> 0;
}

async function main() {
  const url = `https://${masterIp}:${masterPort}/akasha`;
  console.log(`Connecting to ${url} ...`);

  let transport;
  try {
    transport = new WebTransport(url);
    await transport.ready;
  } catch (err) {
    console.error(`WebTransport connection failed: ${err.message}`);
    console.error('Fallback: use WebSocket RTT test instead.');
    console.error('  Run: node poc/ws-rtt-measure.mjs <ip> <port>');
    process.exit(1);
  }

  console.log('Connected. Sending datagram pings...\n');

  const rtts = [];
  const writer = transport.datagrams.writable.getWriter();
  const reader = transport.datagrams.readable.getReader();

  // Start reader
  const readLoop = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      const recvTime = performance.now() * 1000; // μs
      const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
      const sendTime = Number(dv.getBigUint64(0, true)); // μs (as bigint→number)
      const seq = dv.getUint32(8, true);

      // Verify checksum
      const payload = new Uint8Array(value.buffer, value.byteOffset + 12, value.byteLength - 12);
      const expectedCrc = dv.getUint32(value.byteLength - 4, true);
      const actualCrc = fletcher32(payload);

      const rtt = recvTime - sendTime;
      const status = actualCrc === expectedCrc ? 'OK' : 'CORRUPT';
      rtts.push(rtt);
      console.log(`  seq=${seq} rtt=${rtt.toFixed(0)}μs (${(rtt/1000).toFixed(2)}ms) ${status}`);
    }
  })();

  // Send pings
  for (let seq = 0; seq < NUM_PINGS; seq++) {
    const sendTime = BigInt(Math.floor(performance.now() * 1000)); // μs

    // Build datagram: [sendTime:u64 LE] [seq:u32 LE] [padding:8B] [checksum:u32 LE]
    const payloadSize = 32;
    const buf = new ArrayBuffer(16 + payloadSize + 4); // header + payload + checksum
    const dv = new DataView(buf);
    dv.setBigUint64(0, sendTime, true);
    dv.setUint32(8, seq, true);

    // Zero payload (minimal overhead for RTT measurement)
    const payload = new Uint8Array(buf, 16, payloadSize);
    const checksum = fletcher32(payload);
    dv.setUint32(16 + payloadSize, checksum, true);

    await writer.write(new Uint8Array(buf));
    await new Promise(r => setTimeout(r, PING_INTERVAL_MS));
  }

  // Wait for last responses
  await new Promise(r => setTimeout(r, 500));
  await reader.cancel();
  try { await writer.close(); } catch {}
  transport.close();

  // Stats
  rtts.sort((a, b) => a - b);
  const n = rtts.length;
  if (n === 0) { console.log('\nNo responses received.'); process.exit(1); }

  const min = rtts[0];
  const max = rtts[n - 1];
  const median = rtts[Math.floor(n / 2)];
  const p95 = rtts[Math.floor(n * 0.95)];
  const p99 = rtts[Math.floor(n * 0.99)];
  const avg = rtts.reduce((a, b) => a + b, 0) / n;

  console.log(`\n── RTT Statistics (${n} samples) ──`);
  console.log(`  min:    ${min.toFixed(0)}μs (${(min/1000).toFixed(2)}ms)`);
  console.log(`  median: ${median.toFixed(0)}μs (${(median/1000).toFixed(2)}ms)`);
  console.log(`  avg:    ${avg.toFixed(0)}μs (${(avg/1000).toFixed(2)}ms)`);
  console.log(`  p95:    ${p95.toFixed(0)}μs (${(p95/1000).toFixed(2)}ms)`);
  console.log(`  p99:    ${p99.toFixed(0)}μs (${(p99/1000).toFixed(2)}ms)`);
  console.log(`  max:    ${max.toFixed(0)}μs (${(max/1000).toFixed(2)}ms)`);

  // Success criteria check
  const pass = median < 5000; // < 5ms target
  console.log(`\n  PoC success criteria (median < 5ms): ${pass ? '✅ PASS' : '❌ FAIL'}`);
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
