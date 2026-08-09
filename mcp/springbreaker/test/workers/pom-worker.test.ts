import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POMWorker } from "../../src/workers/pom-worker.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "pom-worker-test-" + Date.now());
const POM_PATH = join(TEST_DIR, "pom.xml");

// Minimal POM XML for testing (no namespace to avoid isArray issues)
const MINIMAL_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>test-project</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
      <version>3.2.0</version>
    </dependency>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.1.3-jre</version>
    </dependency>
  </dependencies>
</project>`;

const POM_WITH_PARENT = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>boot-project</artifactId>
  <version>1.0.0</version>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>`;

const POM_WITH_PROPERTIES = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>props-project</artifactId>
  <version>1.0.0</version>
  <properties>
    <guava.version>32.1.3-jre</guava.version>
    <jackson.version>2.15.3</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>\${guava.version}</version>
    </dependency>
  </dependencies>
</project>`;

const POM_WITH_DEP_MGMT = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>mgmt-project</artifactId>
  <version>1.0.0</version>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.google.guava</groupId>
        <artifactId>guava</artifactId>
        <version>32.1.3-jre</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
    </dependency>
  </dependencies>
</project>`;

const POM_WITH_MODULES = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>multi-module</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>module-a</module>
    <module>module-b</module>
  </modules>
</project>`;

describe("POMWorker", () => {
  let worker: POMWorker;

  beforeEach(async () => {
    worker = new POMWorker();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  // Helper to get dependency array from parsed POM data
  function getDeps(
    data: Record<string, unknown>,
  ): Array<Record<string, unknown>> {
    const project = data.project as Record<string, unknown>;
    const deps = project.dependencies as Record<string, unknown>;
    return (deps?.dependency as Array<Record<string, unknown>>) ?? [];
  }

  // ── Critical Invariant: parseTagValue: false ──────────────────────
  describe("parseTagValue: false invariant", () => {
    it("preserves version strings through parse→write round-trip", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const pomData = await worker.readPom(POM_PATH);

      // Verify version is a string, not a number
      const project = pomData.project as Record<string, unknown>;
      expect(typeof project.version).toBe("string");
      expect(project.version).toBe("1.0.0");

      // Write back and re-read — version must NOT be corrupted to "1"
      await worker.writePom(POM_PATH, pomData);
      const pomData2 = await worker.readPom(POM_PATH);
      const project2 = pomData2.project as Record<string, unknown>;
      expect(project2.version).toBe("1.0.0");
    });

    it('preserves "2.0.0" version (not coerced to 2)', async () => {
      const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <version>2.0.0</version>
  <dependencies>
    <dependency>
      <groupId>g</groupId>
      <artifactId>a</artifactId>
      <version>2.0.0</version>
    </dependency>
  </dependencies>
</project>`;
      await writeFile(POM_PATH, pom, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const project = data.project as Record<string, unknown>;
      expect(project.version).toBe("2.0.0");

      await worker.writePom(POM_PATH, data);
      const data2 = await worker.readPom(POM_PATH);
      expect((data2.project as Record<string, unknown>).version).toBe("2.0.0");
    });

    it("preserves semver with pre-release tags", async () => {
      const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <version>1.0.0-RC1</version>
</project>`;
      await writeFile(POM_PATH, pom, "utf-8");
      const data = await worker.readPom(POM_PATH);
      expect((data.project as Record<string, unknown>).version).toBe(
        "1.0.0-RC1",
      );
    });
  });

  // ── readPom / writePom ────────────────────────────────────────────
  describe("readPom", () => {
    it("parses a valid POM file", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);
      expect(data.project).toBeDefined();
    });

    it("throws POMError for missing file", async () => {
      await expect(worker.readPom("/nonexistent/pom.xml")).rejects.toThrow(
        "not found",
      );
    });

    it("parses dependencies as arrays", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const deps = (data.project as Record<string, unknown>)
        .dependencies as Record<string, unknown>;
      expect(Array.isArray(deps.dependency)).toBe(true);
      expect(deps.dependency).toHaveLength(2);
    });
  });

  // ── extractProjectInfo ────────────────────────────────────────────
  describe("extractProjectInfo", () => {
    it("extracts basic project coordinates", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const info = worker.extractProjectInfo(data);

      expect(info.groupId).toBe("com.example");
      expect(info.artifactId).toBe("test-project");
      expect(info.version).toBe("1.0.0");
      expect(info.packaging).toBe("jar");
    });

    it("extracts parent info", async () => {
      await writeFile(POM_PATH, POM_WITH_PARENT, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const info = worker.extractProjectInfo(data);

      expect(info.parent).toBeDefined();
      expect(info.parent?.groupId).toBe("org.springframework.boot");
      expect(info.parent?.artifactId).toBe("spring-boot-starter-parent");
      expect(info.parent?.version).toBe("3.2.0");
    });

    it("extracts modules", async () => {
      await writeFile(POM_PATH, POM_WITH_MODULES, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const info = worker.extractProjectInfo(data);

      expect(info.modules).toEqual(["module-a", "module-b"]);
    });

    it("extracts properties", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const info = worker.extractProjectInfo(data);

      expect(info.properties["guava.version"]).toBe("32.1.3-jre");
      expect(info.properties["jackson.version"]).toBe("2.15.3");
    });
  });

  // ── extractSpringBootVersion ──────────────────────────────────────
  describe("extractSpringBootVersion", () => {
    it("detects Boot version from parent", async () => {
      await writeFile(POM_PATH, POM_WITH_PARENT, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const version = worker.extractSpringBootVersion(data);
      expect(version).toBe("3.2.0");
    });

    it("returns null when no Spring Boot", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const version = worker.extractSpringBootVersion(data);
      expect(version).toBeNull();
    });
  });

  // ── updateDependencyVersion ───────────────────────────────────────
  describe("updateDependencyVersion", () => {
    it("updates direct dependency version", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateDependencyVersion(
        data,
        "com.google.guava",
        "guava",
        "33.0.0-jre",
      );
      expect(result).toBe(true);

      // Verify the update
      const deps = getDeps(data);
      const guava = deps.find(
        (d) => d.groupId === "com.google.guava" && d.artifactId === "guava",
      );
      expect(guava?.version).toBe("33.0.0-jre");
    });

    it("updates property reference instead of literal", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);

      // guava.version is ${guava.version} — should update the property
      const result = worker.updateDependencyVersion(
        data,
        "com.google.guava",
        "guava",
        "33.0.0-jre",
      );
      expect(result).toBe(true);

      // The literal version in deps should still be ${guava.version}
      const deps = getDeps(data);
      const guava = deps.find(
        (d) => d.groupId === "com.google.guava" && d.artifactId === "guava",
      );
      expect(guava?.version).toBe("${guava.version}");

      // The property should be updated
      const props = (data.project as Record<string, unknown>)
        .properties as Record<string, unknown>;
      expect(props["guava.version"]).toBe("33.0.0-jre");
    });

    it("updates dependencyManagement entries", async () => {
      // Use a POM where the dependency is ONLY in dependencyManagement (not in dependencies)
      const pomMgmtOnly = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>mgmt-only-project</artifactId>
  <version>1.0.0</version>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.google.guava</groupId>
        <artifactId>guava</artifactId>
        <version>32.1.3-jre</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`;
      await writeFile(POM_PATH, pomMgmtOnly, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateDependencyVersion(
        data,
        "com.google.guava",
        "guava",
        "33.0.0-jre",
      );
      expect(result).toBe(true);

      const depMgmt = (data.project as Record<string, unknown>)
        .dependencyManagement as Record<string, unknown>;
      const deps = (depMgmt.dependencies as Record<string, unknown>)
        .dependency as Array<Record<string, unknown>>;
      const guava = deps.find(
        (d) => d.groupId === "com.google.guava" && d.artifactId === "guava",
      );
      expect(guava?.version).toBe("33.0.0-jre");
    });

    it("returns false for nonexistent dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateDependencyVersion(
        data,
        "nonexistent",
        "dep",
        "1.0.0",
      );
      expect(result).toBe(false);
    });
  });

  // ── updateParentVersion ───────────────────────────────────────────
  describe("updateParentVersion", () => {
    it("updates parent version", async () => {
      await writeFile(POM_PATH, POM_WITH_PARENT, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateParentVersion(data, "3.3.0");
      expect(result).toBe(true);

      const parent = (data.project as Record<string, unknown>).parent as Record<
        string,
        unknown
      >;
      expect(parent.version).toBe("3.3.0");
    });

    it("returns false when no parent", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateParentVersion(data, "3.3.0");
      expect(result).toBe(false);
    });
  });

  // ── updateProperty ────────────────────────────────────────────────
  describe("updateProperty", () => {
    it("updates an existing property", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateProperty(data, "guava.version", "33.0.0-jre");
      expect(result).toBe(true);

      const props = (data.project as Record<string, unknown>)
        .properties as Record<string, unknown>;
      expect(props["guava.version"]).toBe("33.0.0-jre");
    });

    it("returns false for nonexistent property", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.updateProperty(
        data,
        "nonexistent.version",
        "1.0.0",
      );
      expect(result).toBe(false);
    });
  });

  // ── addExclusion ──────────────────────────────────────────────────
  describe("addExclusion", () => {
    it("adds exclusion to a dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.addExclusion(
        data,
        "com.google.guava",
        "guava",
        "org.checkerframework",
        "checker-qual",
      );
      expect(result).toBe(true);
    });

    it("returns false for duplicate exclusion", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      worker.addExclusion(
        data,
        "com.google.guava",
        "guava",
        "org.checkerframework",
        "checker-qual",
      );
      const result = worker.addExclusion(
        data,
        "com.google.guava",
        "guava",
        "org.checkerframework",
        "checker-qual",
      );
      expect(result).toBe(false);
    });

    it("returns false for nonexistent dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.addExclusion(
        data,
        "nonexistent",
        "dep",
        "excl.g",
        "excl.a",
      );
      expect(result).toBe(false);
    });
  });

  // ── removeDependency ──────────────────────────────────────────────
  describe("removeDependency", () => {
    it("removes an existing dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.removeDependency(data, "com.google.guava", "guava");
      expect(result).toBe(true);

      const deps = getDeps(data);
      expect(deps).toHaveLength(1);
      expect(deps[0].artifactId).toBe("spring-boot-starter-web");
    });

    it("returns false for nonexistent dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      const result = worker.removeDependency(data, "nonexistent", "dep");
      expect(result).toBe(false);
    });
  });

  // ── addDependency ─────────────────────────────────────────────────
  describe("addDependency", () => {
    it("adds a new dependency", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);

      worker.addDependency(
        data,
        "org.apache.commons",
        "commons-lang3",
        "3.14.0",
      );

      const deps = getDeps(data);
      expect(deps).toHaveLength(3);
      const commons = deps.find((d) => d.artifactId === "commons-lang3");
      expect(commons?.version).toBe("3.14.0");
      expect(commons?.scope).toBe("compile");
    });
  });

  // ── extractDependencyManagement ───────────────────────────────────
  describe("extractDependencyManagement", () => {
    it("extracts managed dependencies", async () => {
      await writeFile(POM_PATH, POM_WITH_DEP_MGMT, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const mgmt = worker.extractDependencyManagement(data);

      expect(mgmt).toHaveLength(1);
      expect(mgmt[0].groupId).toBe("com.google.guava");
      expect(mgmt[0].artifactId).toBe("guava");
      expect(mgmt[0].version).toBe("32.1.3-jre");
    });

    it("returns empty array when no dependencyManagement", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");
      const data = await worker.readPom(POM_PATH);
      const mgmt = worker.extractDependencyManagement(data);

      expect(mgmt).toEqual([]);
    });
  });

  // ── backup / restore ─────────────────────────────────────────────
  describe("backup and restore", () => {
    it("creates a backup and restores from it", async () => {
      await writeFile(POM_PATH, MINIMAL_POM, "utf-8");

      const backupPath = await worker.backupPom(POM_PATH);
      expect(backupPath).toContain(".backup.");

      // Modify the POM
      const data = await worker.readPom(POM_PATH);
      worker.updateDependencyVersion(
        data,
        "com.google.guava",
        "guava",
        "999.0.0",
      );
      await worker.writePom(POM_PATH, data);

      // Restore from backup
      await worker.restorePom(backupPath, POM_PATH);
      const restored = await worker.readPom(POM_PATH);
      const deps = getDeps(restored);
      const guava = deps.find((d) => d.artifactId === "guava");
      expect(guava?.version).toBe("32.1.3-jre");
    });

    it("throws for missing backup", async () => {
      await expect(
        worker.restorePom("/nonexistent/backup.xml", POM_PATH),
      ).rejects.toThrow("not found");
    });
  });

  // ── hasProperty / getProperty ─────────────────────────────────────
  describe("property helpers", () => {
    it("hasProperty returns true for existing property", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);
      expect(worker.hasProperty(data, "guava.version")).toBe(true);
      expect(worker.hasProperty(data, "nonexistent")).toBe(false);
    });

    it("getProperty returns value", async () => {
      await writeFile(POM_PATH, POM_WITH_PROPERTIES, "utf-8");
      const data = await worker.readPom(POM_PATH);
      expect(worker.getProperty(data, "guava.version")).toBe("32.1.3-jre");
      expect(worker.getProperty(data, "nonexistent")).toBeNull();
    });
  });
});
