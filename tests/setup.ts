import { vi } from "vitest";

// Suppress console output during tests (EventStore and NotificationService log to console)
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "warn").mockImplementation(() => {});
