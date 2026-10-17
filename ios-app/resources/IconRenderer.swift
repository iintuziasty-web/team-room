import AppKit
import Foundation
let destination = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
func render(_ pixels: Int, _ filename: String) throws {
 let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
 let unit = CGFloat(pixels) / 64
 NSColor(srgbRed: 0.157, green: 0.333, blue: 0.914, alpha: 1).setFill()
 NSBezierPath(roundedRect: NSRect(x: 3*unit, y: 3*unit, width: 58*unit, height: 58*unit), xRadius: 17*unit, yRadius: 17*unit).fill()
 NSColor.white.setStroke()
 for box in [NSRect(x: 16*unit, y: 20*unit, width: 23*unit, height: 24*unit), NSRect(x: 25*unit, y: 17*unit, width: 23*unit, height: 20*unit)] {
  let path = NSBezierPath(roundedRect: box, xRadius: 2*unit, yRadius: 2*unit); path.lineWidth = 3*unit; path.stroke()
 }
 NSGraphicsContext.restoreGraphicsState()
 try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: destination).appendingPathComponent(filename))
}
for logical in [16, 32, 128, 256, 512] {
 try render(logical, "icon_\(logical)x\(logical).png")
 try render(logical*2, "icon_\(logical)x\(logical)@2x.png")
}
try render(1024, "icon-1024.png")
let asset = "{\"images\":[{\"filename\":\"icon-1024.png\",\"idiom\":\"universal\",\"platform\":\"ios\",\"size\":\"1024x1024\"}],\"info\":{\"author\":\"xcode\",\"version\":1}}"
try asset.write(to: URL(fileURLWithPath: destination).appendingPathComponent("Contents.json"), atomically: true, encoding: .utf8)
