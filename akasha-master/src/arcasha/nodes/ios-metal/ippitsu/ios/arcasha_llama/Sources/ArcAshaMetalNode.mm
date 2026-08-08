//
//  ArcAshaMetalNode.mm
//  ArcAshaLlama
//
//  llama.cpp C API wrapper (Objective-C++) — all inference runs on Metal
//  (ggml-metal, embedded metallib). State access is serialized on a queue.
//

#import "ArcAshaMetalNode.h"

#import <string>
#import <vector>

#import "llama.h"

@implementation ArcAshaMetalNode {
    llama_model * _model;
    llama_context * _ctx;
    dispatch_queue_t _queue;
}

+ (instancetype)shared {
    static id _shared = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{ _shared = [[self alloc] init]; });
    return _shared;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _model = NULL;
        _ctx = NULL;
        _queue = dispatch_queue_create("arcasha.metal.llama", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (BOOL)isLoaded {
    __block BOOL loaded = NO;
    dispatch_sync(_queue, ^{ loaded = (_model != NULL && _ctx != NULL); });
    return loaded;
}

- (BOOL)loadModel:(NSString *)path nCtx:(int32_t)nCtx nThreads:(int32_t)nThreads {
    __block BOOL ok = NO;
    dispatch_sync(_queue, ^{
        if (_model != NULL && _ctx != NULL) { ok = YES; return; }

        llama_backend_init();

        llama_model_params mparams = llama_model_default_params();
        mparams.n_gpu_layers = -1;          // all layers to GPU (Metal)
        mparams.use_extra_bufts = true;

        llama_model * m = llama_model_load_from_file(path.UTF8String, mparams);
        if (m == NULL) { NSLog(@"[ArcAshaMetal] model load failed: %@", path); return; }

        llama_context_params cparams = llama_context_default_params();
        cparams.n_ctx           = (uint32_t)nCtx;
        cparams.n_batch         = 512;
        cparams.n_ubatch        = 512;
        cparams.n_threads       = nThreads;
        cparams.n_threads_batch = nThreads;
        cparams.offload_kqv     = true;
        cparams.flash_attn_type = LLAMA_FLASH_ATTN_TYPE_DISABLED;

        llama_context * c = llama_init_from_model(m, cparams);
        if (c == NULL) {
            llama_model_free(m);
            NSLog(@"[ArcAshaMetal] context init failed");
            return;
        }
        _model = m;
        _ctx = c;
        ok = YES;
        NSLog(@"[ArcAshaMetal] model loaded: %@ (ctx=%d, threads=%d)", path, nCtx, nThreads);
    });
    return ok;
}

- (void)unloadModel {
    dispatch_sync(_queue, ^{
        if (_ctx != NULL) { llama_free(_ctx); _ctx = NULL; }
        if (_model != NULL) { llama_model_free(_model); _model = NULL; }
    });
}

- (NSDictionary<NSString *, id> *)generate:(NSString *)prompt
                              maxNewTokens:(int32_t)maxNewTokens
                                temperature:(float)temperature
                                       seed:(uint32_t)seed {
    __block NSDictionary * result = nil;
    dispatch_sync(_queue, ^{
        result = [self generateLocked:prompt maxNewTokens:maxNewTokens temperature:temperature seed:seed];
    });
    return result;
}

- (NSDictionary *)generateLocked:(NSString *)prompt
                    maxNewTokens:(int32_t)maxNewTokens
                      temperature:(float)temperature
                             seed:(uint32_t)seed {
    if (_model == NULL || _ctx == NULL) {
        return @{ @"error": @"model not loaded" };
    }
    // 新しい生成の前に KV キャッシュをクリア (連続呼び出しで decode が失敗しないように)
    llama_memory_clear(llama_get_memory(_ctx), true);
    const llama_vocab * vocab = llama_model_get_vocab(_model);
    NSTimeInterval t0 = [NSDate date].timeIntervalSince1970;

    // ── 1. Chat template (fallback to raw prompt) ──────────────────────────
    std::string genPrompt = std::string(prompt.UTF8String);
    int32_t tplLen = llama_model_meta_val_str(_model, "tokenizer.chat_template", NULL, 0);
    if (tplLen > 0) {
        std::vector<char> tbuf((size_t)tplLen + 1, 0);
        llama_model_meta_val_str(_model, "tokenizer.chat_template", tbuf.data(), tbuf.size());
        std::string tmpl(tbuf.data());
        llama_chat_message msg = { "user", genPrompt.c_str() };
        int32_t need = llama_chat_apply_template(tmpl.c_str(), &msg, 1, true, NULL, 0);
        if (need > 0) {
            std::vector<char> abuf((size_t)need + 1, 0);
            llama_chat_apply_template(tmpl.c_str(), &msg, 1, true, abuf.data(), (int32_t)abuf.size());
            genPrompt = std::string(abuf.data());
        }
    }

    // ── 2. Tokenize ────────────────────────────────────────────────────────
    // 最新 llama.cpp: クエリ呼び出し(tokens=NULL, n_tokens_max=0)は
    // 負数(-必要トークン数)を返す。INT32_MIN はオーバーフロー。
    int32_t nTokens = llama_tokenize(vocab, genPrompt.c_str(), (int32_t)genPrompt.size(), NULL, 0, true, true);
    if (nTokens == INT32_MIN) { return @{ @"error": @"tokenize overflow" }; }
    int32_t required = nTokens < 0 ? -nTokens : nTokens; // 負数 = 必要なバッファサイズ
    if (required <= 0) { return @{ @"error": @"tokenize failed" }; }
    std::vector<llama_token> tokens((size_t)required, 0);
    int32_t tokN = llama_tokenize(vocab, genPrompt.c_str(), (int32_t)genPrompt.size(), tokens.data(), required, true, true);
    if (tokN < 0) { return @{ @"error": @"tokenize failed" }; }
    tokens.resize((size_t)tokN);

    // ── 3. Sampler chain ───────────────────────────────────────────────────
    llama_sampler_chain_params sparams = llama_sampler_chain_default_params();
    llama_sampler * chain = llama_sampler_chain_init(sparams);
    if (chain == NULL) { return @{ @"error": @"sampler init failed" }; }
    if (temperature > 0) { llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature)); }
    llama_sampler_chain_add(chain, llama_sampler_init_dist(seed));

    // ── 4. Batch & prefill ─────────────────────────────────────────────────
    llama_batch batch = llama_batch_init((int32_t)tokens.size() + maxNewTokens, 0, 1);
    for (int i = 0; i < (int)tokens.size(); i++) {
        batch.token[i]    = tokens[(size_t)i];
        batch.pos[i]      = i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = 0;
        batch.logits[i]   = 0;
    }
    batch.n_tokens = (int32_t)tokens.size();
    batch.logits[tokens.size() - 1] = 1;

    if (llama_decode(_ctx, batch) != 0) {
        llama_batch_free(batch);
        llama_sampler_free(chain);
        return @{ @"error": @"prefill decode failed" };
    }
    NSTimeInterval prefillMs = ([NSDate date].timeIntervalSince1970 - t0) * 1000.0;

    // ── 5. Decode loop ─────────────────────────────────────────────────────
    std::vector<uint8_t> outBytes;
    std::vector<int32_t> outTokens;
    llama_token eos = llama_vocab_eos(vocab);

    for (int i = 0; i < maxNewTokens; i++) {
        llama_token id = llama_sampler_sample(chain, _ctx, -1);
        llama_sampler_accept(chain, id);
        outTokens.push_back(id);

        char piece[64];
        int32_t n = llama_token_to_piece(vocab, id, piece, 64, 0, true);
        if (n > 0) {
            for (int32_t b = 0; b < n && b < 64; b++) { outBytes.push_back((uint8_t)piece[b]); }
        }
        if (id == eos) { break; }

        batch.n_tokens    = 1;
        batch.token[0]    = id;
        batch.pos[0]      = (int32_t)tokens.size() + i;
        batch.n_seq_id[0] = 1;
        batch.seq_id[0][0] = 0;
        batch.logits[0]   = 1;
        if (llama_decode(_ctx, batch) != 0) { break; }
    }
    llama_batch_free(batch);
    llama_sampler_free(chain);

    NSTimeInterval totalMs = ([NSDate date].timeIntervalSince1970 - t0) * 1000.0;
    NSString * text = [[NSString alloc] initWithBytes:outBytes.data()
                                               length:outBytes.size()
                                             encoding:NSUTF8StringEncoding];
    NSMutableArray<NSNumber *> * tokenArr = [NSMutableArray arrayWithCapacity:outTokens.size()];
    for (int32_t t : outTokens) { [tokenArr addObject:@(t)]; }

    return @{
        @"text":   (text ?: @""),
        @"tokens": tokenArr,
        @"timing": @{
            @"total_ms":   @(totalMs),
            @"prefill_ms": @(prefillMs),
            @"decode_ms":  @(MAX(0, totalMs - prefillMs)),
        },
    };
}

@end

