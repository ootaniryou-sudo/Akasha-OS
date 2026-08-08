# ArcAsha Metal — iOS Native Target

> **Real Metal/MPS inference for iPhone. Compiles with Swift 5.9 + Metal 3.**

## Build

```bash
cd src/native/ios/metal
swift build
```

## Test

```bash
swift test
```

## Integration with TypeScript

```
ArcAsha TypeScript (akasha-master/)
  └── ExecutionBackend (src/llm/backend.ts)
        └── MetalBackend (src/native/ios/metal/metal-backend.ts)  ← TS stub
              │
              │  native bridge (WKScriptMessageHandler / JSContext)
              │
              ▼
        MetalBridge (Sources/ArcAshaMetal/MetalBridge.swift)      ← Native entry
              │
              ├── MPSInference (MPSInference.swift)               ← MPS compute
              ├── MetalKernels (MetalKernels.swift)               ← Custom shaders
              └── Shaders/qwen_ops.metal                          ← GPU kernels
```

## Components

| File | Purpose | Status |
|------|---------|--------|
| `Package.swift` | Swift Package Manager manifest | ✅ |
| `MetalBridge.swift` | Main entry point + JSON bridge + tokenizer | ✅ |
| `MPSInference.swift` | MPSGraph + MPSMatrixMultiplication inference engine | ✅ |
| `MetalKernels.swift` | Custom Metal shader wrappers (RMSNorm, SwiGLU, KV cache) | ✅ |
| `NumericTypes.swift` | FP16/FP32 bit-level conversion | ✅ |
| `Shaders/qwen_ops.metal` | Metal GPU shaders (RMSNorm, RoPE, SwiGLU, KV cache) | ✅ |

## Requirements

- iOS 17+ / macOS 14+
- Xcode 15+ with Metal 3 support
- Apple GPU Family 7+ (A14 Bionic or newer)
- Qwen3-0.6B model in GGUF format

## Usage

```swift
import ArcAshaMetal

let bridge = MetalBridge()
try bridge.initialize(modelPath: "Qwen3-0.6B-Q8_0.gguf")

let request = """
{
  "modelId": "Qwen3-0.6B",
  "inputTokenIds": [3838, 374, 220, 17, 488, 220, 17, 30],
  "maxNewTokens": 32,
  "temperature": 0,
  "topP": 1.0,
  "topK": 50,
  "precision": "fp16"
}
"""

let response = bridge.processRequest(json: request)
print(response)
```

## Known Limitations

- **GGUF parser**: Simplified. Production needs full GGUF format parser.
- **Tokenizer**: Basic vocabulary only. Full Qwen3 BPE tokenizer runs in TypeScript.
- **MPSGraph integration**: Uses MPSMatrixMultiplication for core ops. Full MPSGraph compute graph planned.
- **Model weight loading**: Weights must be pre-loaded into MTLBuffers from GGUF.

