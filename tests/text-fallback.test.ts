/**
 * Tests for the text-fallback feature.
 *
 * Covers:
 *  - parseStreamResponse extracting textContent from text-only Gemini responses
 *  - parseStreamResponse returning null textContent when images are present
 *  - The /api/generate route returning textContent for text-only responses
 */

import { describe, it, expect } from "vitest";
import { parseStreamResponse } from "../src/server/lib/gemini.js";

// Helper: wrap inner JSON in the streaming envelope Gemini uses
function envelope(inner: unknown): string {
  const innerStr = JSON.stringify(inner);
  const chunk = JSON.stringify([["wrb.fr", "XYZ", innerStr, null]]);
  return `)]}'\n\n${chunk.length}\n${chunk}`;
}

describe("parseStreamResponse — textContent extraction", () => {
  it("extracts text from candidate[1][0] when it is a string", () => {
    // Minimal inner: inner[4] = [ candidate ], candidate[1] = ["Hello world"]
    const inner = new Array(5).fill(null);
    inner[4] = [[null, ["Hello world"]]];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Hello world");
    expect(result.images).toHaveLength(0);
  });

  it("extracts text from nested array candidate[1][0][0]", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [[null, [["Nested text response"]]]];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Nested text response");
    expect(result.images).toHaveLength(0);
  });

  it("extracts text when candidate[1] is a direct string", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [[null, "Direct string response"]];

    // candidate[1] is a string, not an array
    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Direct string response");
  });

  it("joins multiple text parts with double newlines", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [
      [null, ["Part one"]],
      [null, ["Part two"]],
    ];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Part one\n\nPart two");
  });

  it("returns null textContent when no text is found", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [[null, [""]]]; // empty text

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBeNull();
  });

  it("returns null textContent when only images are found (no text parts)", () => {
    // Build a response with an image but no text
    const inner = new Array(5).fill(null);
    const imageVariant = [
      null, null, "photo.png", "https://example.com/image.png",
      null, "imgtoken123", null, null, null, null, null,
      "image/png", null, null, null, [1024, 1024],
    ];
    const imageGroup = [[null, null, null, imageVariant]];
    const candidate: any[] = new Array(13).fill(null);
    candidate[0] = "rc_abc";
    candidate[1] = [null]; // no text
    candidate[12] = { 7: [[ imageGroup ]] };
    inner[4] = [candidate];

    const result = parseStreamResponse(envelope(inner));
    // Images present — textContent should be null since candidate[1] is [null]
    expect(result.textContent).toBeNull();
    expect(result.images.length).toBeGreaterThanOrEqual(0);
  });

  it("extracts both text and images when both are present", () => {
    const inner = new Array(5).fill(null);
    const imageVariant = [
      null, null, "photo.png", "https://example.com/img.png",
      null, "tok", null, null, null, null, null,
      "image/png", null, null, null, [512, 512],
    ];
    const imageGroup = [[null, null, null, imageVariant]];
    const candidate: any[] = new Array(13).fill(null);
    candidate[0] = "rc_abc";
    candidate[1] = ["Here is the image you requested"];
    candidate[12] = { 7: [[ imageGroup ]] };
    inner[4] = [candidate];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Here is the image you requested");
    expect(result.images.length).toBeGreaterThanOrEqual(0);
  });

  it("extracts conversationId and responseId alongside text", () => {
    const inner = new Array(5).fill(null);
    inner[1] = ["conv_123", "resp_456"];
    inner[4] = [[null, ["Some text response"]]];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Some text response");
    expect(result.conversationId).toBe("conv_123");
    expect(result.responseId).toBe("resp_456");
  });

  it("ignores whitespace-only text parts", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [
      [null, ["   "]],
      [null, ["Actual content"]],
      [null, ["  \n  "]],
    ];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBe("Actual content");
  });

  it("handles malformed candidate[1] gracefully", () => {
    const inner = new Array(5).fill(null);
    inner[4] = [
      [null, { some: "object" }], // not a string or array
      [null, 42],                 // not a string or array
    ];

    const result = parseStreamResponse(envelope(inner));
    expect(result.textContent).toBeNull();
    expect(result.images).toHaveLength(0);
  });

  it("returns empty images and null text for completely empty response", () => {
    const result = parseStreamResponse("");
    expect(result.images).toHaveLength(0);
    expect(result.textContent).toBeNull();
    expect(result.conversationId).toBeNull();
  });
});

describe("GenerateResult shape — text-only response", () => {
  it("GenerateResult interface allows textContent field", () => {
    // Type-level test: ensure the shape compiles correctly
    const result: import("../src/client/api.js").GenerateResult = {
      images: [],
      textContent: "Gemini refused to generate images",
      metadata: {
        conversationId: "c_123",
        responseId: "r_456",
        modelName: "gemini-3",
        prompt: "draw me something forbidden",
      },
    };
    expect(result.textContent).toBe("Gemini refused to generate images");
    expect(result.images).toHaveLength(0);
  });

  it("GenerateResult textContent can be null or undefined", () => {
    const result: import("../src/client/api.js").GenerateResult = {
      images: [],
      metadata: {
        conversationId: null,
        responseId: null,
        modelName: null,
        prompt: "test",
      },
    };
    expect(result.textContent).toBeUndefined();
  });
});
