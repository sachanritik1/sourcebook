import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { citedAnswer } from "../../src/ai/answers";

describe("answer citations", () => {
  it("includes only the cited source excerpt", () => {
    const first = {
      chunkId: randomUUID(),
      documentId: randomUUID(),
      filename: "first.txt",
      ordinal: 0,
      content: "Uncited private detail.",
      score: 0.8,
    };
    const second = {
      chunkId: randomUUID(),
      documentId: randomUUID(),
      filename: "second.txt",
      ordinal: 1,
      content: "Cited research evidence.",
      score: 0.9,
    };

    const result = citedAnswer(
      {
        answer: "Cited research evidence.",
        insufficientEvidence: false,
        citations: [2],
        inputTokens: 10,
        outputTokens: 3,
      },
      [first, second],
    );

    expect(result.citations).toEqual([
      {
        chunkId: second.chunkId,
        documentId: second.documentId,
        filename: "second.txt",
        ordinal: 1,
        excerpt: "Cited research evidence.",
      },
    ]);
  });
});
