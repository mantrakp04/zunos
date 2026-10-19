import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

func read(_ name: String) -> CGImage {
    let source = CGImageSourceCreateWithURL(root.appendingPathComponent(name) as CFURL, nil)!
    return CGImageSourceCreateImageAtIndex(source, 0, nil)!
}

func context(_ size: Int) -> CGContext {
    let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                      bytesPerRow: size * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
    c.interpolationQuality = .high
    return c
}

func save(_ image: CGImage, _ name: String) {
    let destination = CGImageDestinationCreateWithURL(root.appendingPathComponent(name) as CFURL,
                                                       UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
}

// Tighten only the alpha fringe. Keep premultiplied RGB and alpha consistent.
func clean(_ image: CGImage) -> CGImage {
    let w = image.width, h = image.height
    let c = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                      bytesPerRow: w * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
    c.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    let data = c.data!.assumingMemoryBound(to: UInt8.self)
    for i in stride(from: 0, to: w * h * 4, by: 4) {
        let old = Int(data[i + 3])
        let alpha = max(0, old - 24) * 255 / 231
        for j in 0..<3 { data[i+j] = old == 0 ? 0 : UInt8(Int(data[i+j]) * alpha / old) }
        data[i+3] = UInt8(alpha)
    }
    return c.makeImage()!
}

let mark = clean(read("sources/mascot.png"))
// Bounds of the generated subject, with its two sound arcs and a small safety inset.
let croppedMark = mark.cropping(to: CGRect(x: 125, y: 126, width: 1105, height: 1038))!
let markCanvas = context(2048)
let markWidth: CGFloat = 1728
let markHeight = markWidth * CGFloat(croppedMark.height) / CGFloat(croppedMark.width)
markCanvas.draw(croppedMark, in: CGRect(x: 160, y: (2048-markHeight)/2,
                                      width: markWidth, height: markHeight))
save(markCanvas.makeImage()!, "logo-mark.png")

// Enforce an exact 100px outer margin and a smooth macOS-style icon silhouette.
let iconCanvas = context(1024)
let outline = CGMutablePath()
outline.move(to: CGPoint(x: 326, y: 100))
outline.addLine(to: CGPoint(x: 698, y: 100))
outline.addCurve(to: CGPoint(x: 924, y: 326), control1: CGPoint(x: 867, y: 100), control2: CGPoint(x: 924, y: 157))
outline.addLine(to: CGPoint(x: 924, y: 698))
outline.addCurve(to: CGPoint(x: 698, y: 924), control1: CGPoint(x: 924, y: 867), control2: CGPoint(x: 867, y: 924))
outline.addLine(to: CGPoint(x: 326, y: 924))
outline.addCurve(to: CGPoint(x: 100, y: 698), control1: CGPoint(x: 157, y: 924), control2: CGPoint(x: 100, y: 867))
outline.addLine(to: CGPoint(x: 100, y: 326))
outline.addCurve(to: CGPoint(x: 326, y: 100), control1: CGPoint(x: 100, y: 157), control2: CGPoint(x: 157, y: 100))
outline.closeSubpath()
iconCanvas.addPath(outline)
iconCanvas.clip()
// A matching opaque undercoat makes alpha fully solid throughout the tile.
iconCanvas.setFillColor(CGColor(srgbRed: 1, green: 0.52, blue: 0.025, alpha: 1))
iconCanvas.fill(CGRect(x: 100, y: 100, width: 824, height: 824))
let tile = read("sources/app-tile.png").cropping(to: CGRect(x: 75, y: 82, width: 1105, height: 1092))!
iconCanvas.draw(tile, in: CGRect(x: 100, y: 100, width: 824, height: 824))
save(iconCanvas.makeImage()!, "app-icon-1024.png")
print("Prepared transparent 2048px mark and 1024px app icon")
