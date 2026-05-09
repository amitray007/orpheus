import CoreGraphics

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
