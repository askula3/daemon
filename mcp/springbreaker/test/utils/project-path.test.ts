import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertPathWithinProject, resolveProjectPath } from "../../src/utils/project-path.js";

const created: string[] = [];
const originalAllowedRoots = process.env.SPRINGBREAKER_ALLOWED_ROOTS;

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

afterEach(async () => {
  if (originalAllowedRoots === undefined) delete process.env.SPRINGBREAKER_ALLOWED_ROOTS;
  else process.env.SPRINGBREAKER_ALLOWED_ROOTS = originalAllowedRoots;
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project path trust boundaries", () => {
  it("canonicalizes aliases before they become lock keys", async () => {
    const root = await temporaryDirectory("springbreaker-path-");
    const project = join(root, "project");
    const alias = join(root, "alias");
    await mkdir(project);
    await symlink(project, alias);
    await expect(resolveProjectPath(alias)).resolves.toBe(await realpath(project));
  });

  it("enforces one or more configured project roots", async () => {
    const allowed = await temporaryDirectory("springbreaker-allowed-");
    const other = await temporaryDirectory("springbreaker-other-");
    const project = join(allowed, "project");
    await mkdir(project);
    process.env.SPRINGBREAKER_ALLOWED_ROOTS = [allowed, join(allowed, "unused")].join(delimiter);
    await mkdir(join(allowed, "unused"));

    await expect(resolveProjectPath(project)).resolves.toBe(await realpath(project));
    await expect(resolveProjectPath(other)).rejects.toThrow("outside SPRINGBREAKER_ALLOWED_ROOTS");
  });

  it("rejects files and symlinks that escape the project", async () => {
    const root = await temporaryDirectory("springbreaker-containment-");
    const project = join(root, "project");
    const outside = join(root, "outside.xml");
    const link = join(project, "pom.xml");
    await mkdir(project);
    await writeFile(outside, "outside", "utf-8");
    await symlink(outside, link);

    await expect(assertPathWithinProject(project, link)).rejects.toThrow("escapes project root");
    await expect(resolveProjectPath(outside)).rejects.toThrow("must be a directory");
  });
});
