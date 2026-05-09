import CoreGraphics

public enum SplitAxis: String, Codable, Sendable, CaseIterable {
    case horizontal
    case vertical
}

public struct CanvasPlacement: Codable, Sendable, Hashable {
    public let terminalID: TerminalID
    public let frame: CGRect

    public init(terminalID: TerminalID, frame: CGRect) {
        self.terminalID = terminalID
        self.frame = frame
    }
}

public indirect enum LayoutSpec: Codable, Sendable, Hashable {
    case leaf(TerminalID)
    case split(axis: SplitAxis, lhs: LayoutSpec, rhs: LayoutSpec, fraction: Double)
    case canvas([CanvasPlacement])

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case kind
        case terminalID
        case axis
        case lhs
        case rhs
        case fraction
        case placements
    }

    private enum Kind: String, Codable {
        case leaf
        case split
        case canvas
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .leaf(let id):
            try container.encode(Kind.leaf, forKey: .kind)
            try container.encode(id, forKey: .terminalID)
        case .split(let axis, let lhs, let rhs, let fraction):
            try container.encode(Kind.split, forKey: .kind)
            try container.encode(axis, forKey: .axis)
            try container.encode(lhs, forKey: .lhs)
            try container.encode(rhs, forKey: .rhs)
            try container.encode(fraction, forKey: .fraction)
        case .canvas(let placements):
            try container.encode(Kind.canvas, forKey: .kind)
            try container.encode(placements, forKey: .placements)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .kind)
        switch kind {
        case .leaf:
            let id = try container.decode(TerminalID.self, forKey: .terminalID)
            self = .leaf(id)
        case .split:
            let axis = try container.decode(SplitAxis.self, forKey: .axis)
            let lhs = try container.decode(LayoutSpec.self, forKey: .lhs)
            let rhs = try container.decode(LayoutSpec.self, forKey: .rhs)
            let fraction = try container.decode(Double.self, forKey: .fraction)
            self = .split(axis: axis, lhs: lhs, rhs: rhs, fraction: fraction)
        case .canvas:
            let placements = try container.decode([CanvasPlacement].self, forKey: .placements)
            self = .canvas(placements)
        }
    }
}

// MARK: - LayoutPosition

public enum LayoutPosition: Codable, Sendable, Hashable {
    case slot(index: Int)
    case canvasFrame(CGRect)

    private enum CodingKeys: String, CodingKey {
        case kind
        case index
        case frame
    }

    private enum Kind: String, Codable {
        case slot
        case canvasFrame
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .slot(let index):
            try container.encode(Kind.slot, forKey: .kind)
            try container.encode(index, forKey: .index)
        case .canvasFrame(let rect):
            try container.encode(Kind.canvasFrame, forKey: .kind)
            try container.encode(rect, forKey: .frame)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(Kind.self, forKey: .kind)
        switch kind {
        case .slot:
            let index = try container.decode(Int.self, forKey: .index)
            self = .slot(index: index)
        case .canvasFrame:
            let rect = try container.decode(CGRect.self, forKey: .frame)
            self = .canvasFrame(rect)
        }
    }
}
