import Flutter
import UIKit
import ArcAshaLlama

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)

    if let controller = window?.rootViewController as? FlutterViewController {
      let engine = ArcAshaMetalNode.shared()
      let channel = FlutterMethodChannel(name: "arcasha/metal", binaryMessenger: controller.binaryMessenger)
      channel.setMethodCallHandler { [weak engine] call, result in
        guard let engine = engine else { result(nil); return }
        switch call.method {
        case "load":
          guard let args = call.arguments as? [String: Any],
                let path = args["path"] as? String else {
            result(FlutterError(code: "bad_args", message: "path required", details: nil)); return
          }
          let nCtx = (args["nCtx"] as? NSNumber)?.int32Value ?? 2048
          let nThreads = (args["nThreads"] as? NSNumber)?.int32Value ?? 4
          DispatchQueue.global(qos: .userInitiated).async {
            let ok = engine.loadModel(path, nCtx: nCtx, nThreads: nThreads)
            DispatchQueue.main.async { result(ok) }
          }

        case "generate":
          guard let args = call.arguments as? [String: Any],
                let prompt = args["prompt"] as? String else {
            result(FlutterError(code: "bad_args", message: "prompt required", details: nil)); return
          }
          let maxNew = (args["maxNewTokens"] as? NSNumber)?.int32Value ?? 64
          let temp = (args["temperature"] as? NSNumber)?.floatValue ?? 0.0
          DispatchQueue.global(qos: .userInitiated).async {
            let out = engine.generate(prompt, maxNewTokens: maxNew, temperature: temp, seed: 42)
            DispatchQueue.main.async { result(out) }
          }

        case "unload":
          DispatchQueue.global(qos: .userInitiated).async {
            engine.unloadModel()
            DispatchQueue.main.async { result(true) }
          }

        case "isLoaded":
          result(engine.isLoaded)

        default:
          result(FlutterMethodNotImplemented)
        }
      }
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

