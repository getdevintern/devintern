import { test, expect, describe } from "bun:test";
import { join } from "node:path";

/**
 * Test prompt loading from different execution contexts
 */

// Simulate the loadPrompt function from index.ts (with smart path detection)
async function loadPrompt(
  sourceType: "figma" | "log" | "prompt",
  style: "technical" | "pm",
  filename: string,
  replacements: Record<string, string> = {},
): Promise<string> {
  // Detect if we're running from dist/ (bundled) or from source
  const isBundle = import.meta.dir.endsWith("/dist") || import.meta.dir.endsWith("\\dist");
  const baseDir = isBundle ? join(import.meta.dir, "..") : import.meta.dir;

  const promptPath = join(baseDir, "prompts", sourceType, style, filename);
  const promptFile = Bun.file(promptPath);
  let prompt = await promptFile.text();

  // Replace all placeholders
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
  }

  return prompt.trim();
}

// Alternative implementation without the ".." for local development
async function loadPromptLocal(
  sourceType: "figma" | "log" | "prompt",
  style: "technical" | "pm",
  filename: string,
  replacements: Record<string, string> = {},
): Promise<string> {
  const promptPath = join(import.meta.dir, "prompts", sourceType, style, filename);
  const promptFile = Bun.file(promptPath);
  let prompt = await promptFile.text();

  // Replace all placeholders
  for (const [key, value] of Object.entries(replacements)) {
    prompt = prompt.replace(new RegExp(`{{${key}}}`, "g"), value);
  }

  return prompt.trim();
}

describe("Prompt Loading", () => {
  describe("Smart path detection (works in both local and bundled)", () => {
    test("should load figma pm story-generation prompt", async () => {
      const prompt = await loadPrompt("figma", "pm", "story-generation.txt");
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(0);
    });

    test("should load log technical story-generation prompt", async () => {
      const prompt = await loadPrompt("log", "technical", "story-generation.txt");
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(0);
    });

    test("should load prompt pm decomposition prompt", async () => {
      const prompt = await loadPrompt("prompt", "pm", "decomposition.txt");
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(0);
    });

    test("should replace placeholders correctly", async () => {
      const prompt = await loadPrompt("figma", "pm", "story-generation.txt", {
        figmaUrl: "https://figma.com/test",
        epicContext: "PROJ-123",
      });
      expect(prompt).toContain("https://figma.com/test");
      expect(prompt).toContain("PROJ-123");
    });
  });

  describe("Local development fallback (without smart detection)", () => {
    test("should load figma pm story-generation prompt", async () => {
      const prompt = await loadPromptLocal("figma", "pm", "story-generation.txt");
      expect(prompt).toBeTruthy();
      expect(prompt.length).toBeGreaterThan(0);
    });
  });

  describe("Path resolution check", () => {
    test("should identify current execution context", () => {
      const currentDir = import.meta.dir;
      const isInDist = currentDir.endsWith("/dist") || currentDir.endsWith("\\dist");

      console.log("Current directory:", currentDir);
      console.log("Is in dist?", isInDist);
      console.log("Expected prompts path (with ..):", join(currentDir, "..", "prompts"));
      console.log("Expected prompts path (without ..):", join(currentDir, "prompts"));

      expect(currentDir).toBeTruthy();
    });

    test("should check if prompts directory exists at both possible locations", async () => {
      const currentDir = import.meta.dir;

      // Check with ".." (for bundled/dist scenario)
      const pathWithParent = join(
        currentDir,
        "..",
        "prompts",
        "figma",
        "pm",
        "story-generation.txt",
      );
      const existsWithParent = await Bun.file(pathWithParent).exists();

      // Check without ".." (for local development)
      const pathWithoutParent = join(currentDir, "prompts", "figma", "pm", "story-generation.txt");
      const existsWithoutParent = await Bun.file(pathWithoutParent).exists();

      console.log("\nPath resolution test:");
      console.log("  With '..':", pathWithParent, "-> exists:", existsWithParent);
      console.log("  Without '..':", pathWithoutParent, "-> exists:", existsWithoutParent);

      // At least one should exist
      expect(existsWithParent || existsWithoutParent).toBe(true);

      // Report which one works
      if (existsWithParent && !existsWithoutParent) {
        console.log("  ✓ Running from dist/ (bundled)");
      } else if (!existsWithParent && existsWithoutParent) {
        console.log("  ✓ Running from project root (local development)");
      } else if (existsWithParent && existsWithoutParent) {
        console.log("  ⚠ Both paths exist (unexpected)");
      }
    });
  });
});
