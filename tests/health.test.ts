import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/health/route";

describe("GET /api/health", () => {
  it("reports a healthy local application without external dependencies", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body).toMatchObject({
      status: "ok",
      service: "personal-asset-knowledge-platform",
    });
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });
});
