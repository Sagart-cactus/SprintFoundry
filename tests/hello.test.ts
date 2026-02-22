import { describe, expect, it, vi } from "vitest";
import { hello, logHello } from "../src/utils/hello.js";

describe("hello", () => {
  it("should exist as a function", () => {
    expect(hello).toBeDefined();
    expect(typeof hello).toBe("function");
  });

  it("should return the string 'Hello, World!'", () => {
    const result = hello();
    expect(result).toBe("Hello, World!");
  });

  it("should return a string type", () => {
    const result = hello();
    expect(typeof result).toBe("string");
  });

  it("should be callable without errors", () => {
    expect(() => hello()).not.toThrow();
  });

  it("should consistently return the same value", () => {
    const result1 = hello();
    const result2 = hello();
    expect(result1).toBe(result2);
  });
});

describe("logHello", () => {
  it("should exist as a function", () => {
    expect(logHello).toBeDefined();
    expect(typeof logHello).toBe("function");
  });

  it("should call console.log with 'Hello, World!'", () => {
    const consoleSpy = vi.spyOn(console, "log");

    logHello();

    expect(consoleSpy).toHaveBeenCalledWith("Hello, World!");
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });

  it("should be callable without errors", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => logHello()).not.toThrow();

    consoleSpy.mockRestore();
  });

  it("should return void (undefined)", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = logHello();
    expect(result).toBeUndefined();

    consoleSpy.mockRestore();
  });
});
