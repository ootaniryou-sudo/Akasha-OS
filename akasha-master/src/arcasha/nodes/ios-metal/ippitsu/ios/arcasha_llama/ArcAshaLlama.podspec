Pod::Spec.new do |s|
  s.name             = 'ArcAshaLlama'
  s.version          = '0.1.0'
  s.summary          = 'ArcAsha iOS Metal LLM inference — llama.cpp (GGML-Metal) static build'
  s.description      = <<-DESC
    Prebuilt llama.cpp + ggml-metal static libraries (arm64, iOS 16.4+)
    with the Metal shader library embedded (GGML_METAL_EMBED_LIBRARY).
    Swift wrapper for on-device LLM generation via Metal.
  DESC
  s.homepage         = 'https://github.com/ootaniryou-sudo/ArcAsha-os'
  s.license          = { :type => 'MIT', :file => 'LICENSE' }
  s.author           = { 'ArcAsha' => 'arcasha@akasha-os.dev' }
  s.platform         = :ios, '16.4'
  s.source           = { :path => '.' }
  s.swift_version    = '5.9'

  s.source_files         = 'Sources/**/*.{h,m,mm}'
  s.public_header_files  = 'Sources/*.h'
  s.vendored_libraries   = 'lib/*.a'

  s.frameworks = 'Metal', 'MetalKit', 'Accelerate', 'Foundation'
  s.libraries  = 'c++', 'z'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY'           => 'libc++',
    'GCC_ENABLE_CPP_EXCEPTIONS'   => 'YES',
    'GCC_ENABLE_OBJC_EXCEPTIONS'  => 'YES',
    'HEADER_SEARCH_PATHS'         => '$(inherited) "${PODS_TARGET_SRCROOT}/include"',
    'OTHER_LDFLAGS'               => '$(inherited) -ObjC',
  }
end

