//
//  ArcAshaMetalNode.h
//  ArcAshaLlama
//
//  Public ObjC API for on-device LLM inference via Metal (llama.cpp + ggml-metal).
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArcAshaMetalNode : NSObject

@property (nonatomic, readonly) BOOL isLoaded;

+ (instancetype)shared;

/// Load a GGUF model, offloading all layers to Metal. Thread-safe.
/// - Returns: YES on success.
- (BOOL)loadModel:(NSString *)path nCtx:(int32_t)nCtx nThreads:(int32_t)nThreads;

/// Unload the model and free all resources. Thread-safe.
- (void)unloadModel;

/// Synchronous generation (call on a background thread; blocks until done).
/// - Returns: dict {text, tokens, timing:{total_ms,prefill_ms,decode_ms}} or {error}.
- (NSDictionary<NSString *, id> *)generate:(NSString *)prompt
                              maxNewTokens:(int32_t)maxNewTokens
                                temperature:(float)temperature
                                       seed:(uint32_t)seed;

@end

NS_ASSUME_NONNULL_END

