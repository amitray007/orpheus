import Foundation

/// Parses Claude Code session JSONL metadata in two reads:
/// one for the header (line 1) and one backward scan for the last
/// non-empty line.
///
/// ## Tolerance rules
/// - Empty file → returns `nil`.
/// - Header-only valid file → returns `SessionMetadata` with file-mtime
///   as `lastUpdated` and `nil` `lastMessageKind`.
/// - Trailing partial write → ignored; the last *complete* line is used.
/// - Malformed header (bad JSON or missing required fields `cwd`/`sessionId`)
///   → throws `OrpheusCoreError.corruptJSONL(path:line:)` with `line = 1`.
/// - Malformed last line → logged; mtime used as `lastUpdated`.
public struct JSONLLineParser: Sendable {

    public init() {}

    /// Parse the JSONL file at `fileURL` and return metadata, or `nil` for
    /// an empty file.
    ///
    /// - Throws: `OrpheusCoreError.corruptJSONL` if the header is unreadable.
    public func parse(fileURL: URL) throws -> SessionMetadata? {
        let path = fileURL.path

        guard let handle = FileHandle(forReadingAtPath: path) else {
            return nil
        }
        defer { try? handle.close() }

        // --- Read the header line (first line) ---
        let headerData = readFirstLine(from: handle)
        guard let headerData, !headerData.isEmpty else {
            // Empty file → nil, no throw.
            return nil
        }

        // Parse header JSON.
        guard
            let headerJSON = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
            let sessionIDStr = headerJSON["sessionId"] as? String,
            let cwd = headerJSON["cwd"] as? String,
            !sessionIDStr.isEmpty,
            !cwd.isEmpty
        else {
            throw OrpheusCoreError.corruptJSONL(path: path, line: 1)
        }

        let gitBranch = headerJSON["gitBranch"] as? String
        let name = headerJSON["name"] as? String

        // --- File modification time (fallback for lastUpdated) ---
        let mtime = fileMtime(url: fileURL)

        // --- Read the last non-empty line ---
        let fileSize = (try? handle.seekToEnd()) ?? 0
        if fileSize == 0 {
            // Should not happen (we already read header data), but guard anyway.
            return SessionMetadata(
                sessionID: SessionID(rawValue: sessionIDStr),
                cwd: cwd,
                gitBranch: gitBranch,
                name: name,
                lastUpdated: mtime,
                lastMessageKind: nil
            )
        }

        let lastLineData = readLastLine(from: handle, fileSize: fileSize, headerData: headerData)

        var lastUpdated: Date = mtime
        var lastMessageKind: String?

        if let lastLine = lastLineData, !lastLine.isEmpty {
            if let json = try? JSONSerialization.jsonObject(with: lastLine) as? [String: Any] {
                if let ts = json["lastUpdated"] as? String {
                    let formatter = ISO8601DateFormatter()
                    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    if let parsed = formatter.date(from: ts) {
                        lastUpdated = parsed
                    } else {
                        // Try without fractional seconds.
                        let strictFmt = ISO8601DateFormatter()
                        strictFmt.formatOptions = [.withInternetDateTime]
                        if let parsed2 = strictFmt.date(from: ts) {
                            lastUpdated = parsed2
                        }
                    }
                }
                lastMessageKind = json["type"] as? String
            } else {
                // Malformed last line → log + use mtime.
                OrpheusLogger.sessions.warning(
                    "JSONLLineParser: malformed last line in \(path, privacy: .public) — using mtime"
                )
            }
        }
        // If lastLine is nil (header-only), we keep mtime + nil kind.

        return SessionMetadata(
            sessionID: SessionID(rawValue: sessionIDStr),
            cwd: cwd,
            gitBranch: gitBranch,
            name: name,
            lastUpdated: lastUpdated,
            lastMessageKind: lastMessageKind
        )
    }

    // MARK: - Private helpers

    /// Read bytes from `handle` until the first `\n` (or EOF), returning the
    /// line content *without* the newline byte.
    private func readFirstLine(from handle: FileHandle) -> Data? {
        try? handle.seek(toOffset: 0)

        var result = Data()
        let chunkSize = 512

        while true {
            guard let chunk = try? handle.read(upToCount: chunkSize), !chunk.isEmpty else {
                break
            }
            if let nlIdx = chunk.firstIndex(of: UInt8(ascii: "\n")) {
                result.append(chunk[chunk.startIndex..<nlIdx])
                return result
            }
            result.append(chunk)
        }
        return result.isEmpty ? nil : result
    }

    /// Walk backwards from the end of the file looking for the last complete
    /// (non-empty) line.  Returns `nil` if the only content is the header or
    /// there is no second line.
    ///
    /// A "complete" line ends at a `\n` byte (or the very beginning of the
    /// file if there is no newline before it, which means the whole file is
    /// one line).  Trailing partial writes (no terminating newline) are skipped.
    private func readLastLine(from handle: FileHandle, fileSize: UInt64, headerData: Data) -> Data? {
        // headerData.count + 1 for the newline after the header.
        let headerEnd = UInt64(headerData.count + 1)
        guard fileSize > headerEnd else {
            // File contains only the header (possibly with a trailing newline).
            return nil
        }

        let chunkSize: UInt64 = 4096
        var scanPos = fileSize

        // Accumulate bytes from the end.  We are building lines from right to left.
        var tail = Data()

        // We need to find: the start of the last *complete* line (one that ends
        // at or before `fileSize` with a `\n`), then the start of that line.
        //
        // Strategy:
        //   1. Check if the very last byte is `\n`; if so the file ends cleanly
        //      and we look for the line that ends at fileSize-1.
        //   2. If the last byte is NOT `\n`, the file has a partial trailing
        //      line; skip backward past it to find the previous `\n`, then find
        //      the `\n` before that to bound the previous complete line.
        //   3. Keep reading backward until we have the full last complete line.

        // Step 1: determine if the file has a trailing incomplete line.
        let lastBytePos = fileSize - 1
        try? handle.seek(toOffset: lastBytePos)
        guard let lastByte = try? handle.read(upToCount: 1), lastByte.count == 1 else {
            return nil
        }
        let hasTrailingPartial = lastByte[0] != UInt8(ascii: "\n")

        // We'll scan backwards accumulating bytes.  Newlines found mark line ends.
        // We need to collect:
        //   - If hasTrailingPartial: skip the first newline we find (end of last complete line),
        //     then collect the line between that newline and the previous one.
        //   - If !hasTrailingPartial: collect the line ending at fileSize - 1 (before the \n).
        //
        // Implementation: scan chunks from the back, building `tail`.
        // Track how many newlines we've found.

        var newlinesFound = 0
        var lastLineEnd: Int = -1   // index in `tail` where the last line ends
        var lastLineStart: Int = -1 // index in `tail` where the last line starts

        scanPos = fileSize

        while scanPos > 0 {
            let readSize = min(chunkSize, scanPos)
            scanPos -= readSize
            try? handle.seek(toOffset: scanPos)
            guard let chunk = try? handle.read(upToCount: Int(readSize)), !chunk.isEmpty else {
                break
            }
            // Prepend chunk to tail (we're reading backwards).
            tail.insert(contentsOf: chunk, at: 0)

            // Adjust tail length relative to file end: the byte at tail[tail.count-1]
            // corresponds to fileSize-1, etc.
            let tailStart = Int(fileSize) - tail.count

            // Scan tail from the end for newlines.
            for i in stride(from: tail.count - 1, through: 0, by: -1) {
                let absolutePos = tailStart + i
                guard absolutePos >= Int(headerEnd) - 1 else {
                    // We've gone past the header boundary; stop.
                    if newlinesFound == (hasTrailingPartial ? 2 : 1) {
                        lastLineStart = i + 1
                    } else if newlinesFound == (hasTrailingPartial ? 1 : 0) && lastLineEnd >= 0 {
                        lastLineStart = 0
                    }
                    break
                }
                if tail[i] == UInt8(ascii: "\n") {
                    newlinesFound += 1
                    if hasTrailingPartial {
                        if newlinesFound == 1 {
                            lastLineEnd = i  // end of last complete line (exclusive, = position of \n)
                        } else if newlinesFound == 2 {
                            lastLineStart = i + 1
                            break
                        }
                    } else {
                        if newlinesFound == 1 {
                            lastLineEnd = i  // position of terminal \n
                            // The line ends just before this \n.
                        } else if newlinesFound == 2 {
                            lastLineStart = i + 1
                            break
                        }
                    }
                }
            }

            if lastLineStart >= 0 { break }
            if scanPos == 0 { break }
        }

        // If we scanned all the way and found the end but not the start,
        // the last complete line starts right after headerEnd.
        if lastLineEnd >= 0 && lastLineStart < 0 {
            // The last complete line starts at headerEnd in the file.
            // In tail coordinates: tail[0] corresponds to tailStart (= fileSize - tail.count)
            // We need the position of headerEnd in tail.
            let tailStart = Int(fileSize) - tail.count
            let headerEndInTail = Int(headerEnd) - tailStart
            lastLineStart = max(0, headerEndInTail)
        }

        guard lastLineEnd >= 0, lastLineStart >= 0, lastLineEnd > lastLineStart else {
            return nil
        }

        let slice = tail[lastLineStart..<lastLineEnd]
        // Filter out empty (all-whitespace) slices.
        let trimmed = slice.filter { $0 != UInt8(ascii: "\r") && $0 != UInt8(ascii: "\n") && $0 != UInt8(ascii: " ") }
        if trimmed.isEmpty { return nil }

        return Data(slice)
    }

    /// Return the modification time of the file, defaulting to now on error.
    private func fileMtime(url: URL) -> Date {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
    }
}
