import { describe, it, expect } from "vitest";
import {
  parseGrokModelsOutput,
  parseModelIdLines,
} from "../src/list-models.js";

describe("parseGrokModelsOutput", () => {
  it("extracts only ids present in CLI output", () => {
    const text = `
Default model: grok-4.5
Available models:
  * grok-4.5 (default)
  * grok-4
`;
    const ids = parseGrokModelsOutput(text);
    expect(ids).toContain("grok-4.5");
    expect(ids).not.toContain("sonnet");
    expect(ids).not.toContain("gpt-5.1");
  });

  it("returns empty on empty/noise", () => {
    expect(parseGrokModelsOutput("Usage: grok [OPTIONS]")).toEqual([]);
  });
});

describe("parseModelIdLines", () => {
  it("does not invent product names from prose", () => {
    const ids = parseModelIdLines("Use the model for your task with options");
    expect(ids.every((id) => !/^(use|the|for|with)$/i.test(id))).toBe(true);
  });
});
