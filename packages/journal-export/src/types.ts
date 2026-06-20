// The portable export file model. Canonical JSON; the suggested
// on-disk name is `<contentDigest>.irisjournal`. A self-contained, content-
// addressed, tamper-evident capture of a session's snapshot + journal tail.

export interface ExportRecord {
  seq: number;
  bytesB64: string; // base64 of the EXACT stored record bytes (canonical JSON)
  hash: string; // diagnostic: sha256(recordBytes); verification recomputes it
}

export interface ExportSnapshot {
  upToSeq: number;
  bytesB64: string; // base64 of the stored snapshot state bytes (canonical JSON)
  hash: string; // diagnostic: sha256(snapshotBytes)
}

export interface JournalExportV1 {
  format: "iris-journal-export";
  version: 1;
  algorithm: "sha256/iris-journal-v1";
  sessionId: string;
  defDigest: string; // governing digest = last included record's defDigest; "" if 0 records
  complete: boolean; // three-way rule (mirrors verifySession)
  range: { from: number; to: number } | null; // null ⇔ 0 records
  snapshot: ExportSnapshot | null;
  records: ExportRecord[];
  chainHash: string; // tamper-evident over genesis + record order/content
  contentDigest: string; // THE content address (sha256 over the addressing preimage)
}
