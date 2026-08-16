import { beforeEach, describe, expect, it, vi } from "vitest";
import { MavenCentralWorker } from "../../src/workers/maven-central-worker.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function response(versions: string[], numFound: number): Response {
  return new Response(JSON.stringify({
    response: { numFound, docs: versions.map((v) => ({ v })) },
  }), { headers: { "Content-Type": "application/json" } });
}

describe("MavenCentralWorker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the GAV core and paginates version records", async () => {
    mockFetch
      .mockResolvedValueOnce(response(Array.from({ length: 200 }, (_, index) => `1.0.${index}`), 201))
      .mockResolvedValueOnce(response(["2.0.0"], 201));

    const versions = await new MavenCentralWorker().getAllVersions("org.example", "library");

    expect(versions).toHaveLength(201);
    expect(versions).toContain("2.0.0");
    const first = new URL(String(mockFetch.mock.calls[0][0]));
    const second = new URL(String(mockFetch.mock.calls[1][0]));
    expect(first.searchParams.get("core")).toBe("gav");
    expect(first.searchParams.get("start")).toBe("0");
    expect(second.searchParams.get("start")).toBe("200");
  });

  it("chooses the newest policy-compliant Maven version", async () => {
    mockFetch.mockResolvedValueOnce(response([
      "3.0.0",
      "2.0.0-RC1",
      "1.3.0-redhat-00001",
      "1.2.1-SNAPSHOT",
      "1.2.0",
      "1.1.9",
    ], 6));

    const suggestion = await new MavenCentralWorker().suggestUpgrade(
      "org.example",
      "library",
      "1.1.0",
      { allowMinor: true, allowMajor: false },
    );
    expect(suggestion).toEqual({ suggested: "1.2.0", current: "1.1.0", type: "minor" });
  });
});
