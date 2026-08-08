import Foundation
import Metal
import MetalPerformanceShaders

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Numeric Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/// FP16 ↔ FP32 conversion utilities for Metal buffers.
enum NumericTypes {
  /// Convert Float32 array to Float16 bytes for Metal buffer.
  static func float32ToFloat16(_ values: [Float]) -> Data {
    var f16 = [UInt16](repeating: 0, count: values.count)
    values.withUnsafeBytes { f32Ptr in
      let src = f32Ptr.bindMemory(to: Float.self)
      f16.withUnsafeMutableBytes { f16Ptr in
        let dst = f16Ptr.bindMemory(to: UInt16.self)
        var count = values.count
        src.withMemoryRebound(to: Float.self, capacity: count) { rebound in
          dst.withMemoryRebound(to: UInt16.self, capacity: count) { _ in
            // Convert via vImage or manual bit conversion
            for i in 0..<count {
              f16[i] = float32ToFloat16Bit(rebound[i])
            }
          }
        }
      }
    }
    return Data(bytes: f16, count: f16.count * 2)
  }

  /// Convert Float16 bytes back to Float32.
  static func float16ToFloat32(_ data: Data) -> [Float] {
    let count = data.count / 2
    return data.withUnsafeBytes { ptr in
      let src = ptr.bindMemory(to: UInt16.self)
      return (0..<count).map { float16BitToFloat32(src[$0]) }
    }
  }

  /// Float32 → Float16 bit conversion (truncation).
  static func float32ToFloat16Bit(_ value: Float) -> UInt16 {
    let bits = value.bitPattern
    let sign = (bits >> 16) & 0x8000
    let exp32 = (bits >> 23) & 0xFF
    let mant32 = bits & 0x7FFFFF

    if exp32 == 0xFF { // NaN/Inf
      return UInt16(sign | 0x7C00 | ((mant32 >> 13) & 0x3FF))
    }

    let exp16 = Int(exp32) - 127 + 15
    if exp16 <= 0 { return UInt16(sign) } // Underflow → 0
    if exp16 >= 31 { return UInt16(sign | 0x7C00) } // Overflow → Inf

    return UInt16(sign | (UInt32(exp16) << 10) | ((mant32 >> 13) & 0x3FF))
  }

  /// Float16 → Float32 bit conversion.
  static func float16BitToFloat32(_ value: UInt16) -> Float {
    let sign = UInt32((value >> 15) & 1) << 31
    let exp16 = UInt32((value >> 10) & 0x1F)
    let mant16 = UInt32(value & 0x3FF)

    if exp16 == 0 {
      if mant16 == 0 { return Float(bitPattern: sign) } // ±0
      // Subnormal: normalize
      let mant = mant16
      var e = -14
      var m = mant
      while (m & 0x400) == 0 { m <<= 1; e -= 1 }
      let exp = UInt32(127 + e)
      return Float(bitPattern: sign | (exp << 23) | ((m & 0x3FF) << 13))
    }

    if exp16 == 31 {
      return mant16 == 0
        ? Float(bitPattern: sign | 0x7F800000) // Inf
        : Float.nan // NaN
    }

    let exp = UInt32(Int(exp16) - 15 + 127)
    return Float(bitPattern: sign | (exp << 23) | (mant16 << 13))
  }
}

