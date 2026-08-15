import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { readFile, writeFile, access, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createChildLogger } from "../utils/logger.js";
import { POMError } from "../utils/errors.js";
import type {
  DependencyManagementEntry,
  DependencyScope,
} from "../types/index.js";

const log = createChildLogger("POMWorker");

// XML parser options
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  // CRITICAL: keep all text values as strings. With parseTagValue:true,
  // fast-xml-parser coerces numeric-looking text to JS numbers, so
  // <version>2.0.0</version> becomes 2 and re-serializes as <version>2</version>,
  // silently corrupting POMs on every write.
  parseTagValue: false,
  trimValues: true,
  isArray: (name: string) => {
    // Always parse these as arrays
    return [
      "dependency",
      "plugin",
      "profile",
      "module",
      "exclusion",
      "property",
    ].includes(name);
  },
};

// XML builder options
const builderOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  indentBy: "  ",
  suppressEmptyNode: true,
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class POMWorker {
  private parser: XMLParser;
  private builder: XMLBuilder;

  constructor() {
    this.parser = new XMLParser(parserOptions);
    this.builder = new XMLBuilder(builderOptions);
  }

  // Read and parse a pom.xml file (truly async)
  async readPom(pomPath: string): Promise<Record<string, unknown>> {
    if (!(await fileExists(pomPath))) {
      throw new POMError(`POM file not found: ${pomPath}`);
    }

    const content = await readFile(pomPath, "utf-8");
    try {
      return this.parser.parse(content) as Record<string, unknown>;
    } catch (error) {
      throw new POMError(`Failed to parse POM: ${error}`);
    }
  }

  // Read raw POM content (truly async)
  async readPomContent(pomPath: string): Promise<string> {
    if (!(await fileExists(pomPath))) {
      throw new POMError(`POM file not found: ${pomPath}`);
    }
    return readFile(pomPath, "utf-8");
  }

  // Write pom.xml file (truly async)
  async writePom(
    pomPath: string,
    pomData: Record<string, unknown>,
  ): Promise<void> {
    try {
      const xml = this.builder.build(pomData);
      await writeFile(pomPath, xml, "utf-8");
      log.info(`POM written: ${pomPath}`);
    } catch (error) {
      throw new POMError(`Failed to write POM: ${error}`);
    }
  }

  // Create backup of pom.xml (truly async)
  async backupPom(pomPath: string): Promise<string> {
    const backupPath = `${pomPath}.backup.${Date.now()}`;
    await copyFile(pomPath, backupPath);
    log.info(`POM backed up: ${backupPath}`);
    return backupPath;
  }

  // Restore pom.xml from backup (truly async)
  async restorePom(backupPath: string, pomPath: string): Promise<void> {
    if (!(await fileExists(backupPath))) {
      throw new POMError(`Backup not found: ${backupPath}`);
    }
    await copyFile(backupPath, pomPath);
    log.info(`POM restored from: ${backupPath}`);
  }

  // Extract project information from POM
  extractProjectInfo(pomData: Record<string, unknown>): {
    groupId: string | null;
    artifactId: string | null;
    version: string | null;
    packaging: string;
    parent?: {
      groupId: string;
      artifactId: string;
      version: string;
    };
    modules: string[];
    properties: Record<string, string>;
  } {
    const project = (pomData.project as Record<string, unknown>) || {};

    return {
      groupId: this.extractValue(project, "groupId"),
      artifactId: this.extractValue(project, "artifactId"),
      version: this.extractValue(project, "version"),
      packaging: this.extractValue(project, "packaging") || "jar",
      parent: this.extractParent(project),
      modules: this.extractModules(project),
      properties: this.extractProperties(project),
    };
  }

  // Extract parent POM information
  private extractParent(project: Record<string, unknown>):
    | {
        groupId: string;
        artifactId: string;
        version: string;
      }
    | undefined {
    const parent = project.parent as Record<string, unknown>;
    if (!parent) return undefined;

    const groupId = this.extractValue(parent, "groupId");
    const artifactId = this.extractValue(parent, "artifactId");
    const version = this.extractValue(parent, "version");

    if (!groupId || !artifactId || !version) return undefined;

    return { groupId, artifactId, version };
  }

  // Extract modules list
  private extractModules(project: Record<string, unknown>): string[] {
    const modules = project.modules;
    if (!modules) return [];

    if (Array.isArray(modules)) {
      return modules
        .map((m) =>
          typeof m === "string"
            ? m
            : ((m as Record<string, unknown>)?.module as string) || "",
        )
        .filter(Boolean);
    }

    if (typeof modules === "object" && modules !== null) {
      const mod = (modules as Record<string, unknown>).module;
      if (Array.isArray(mod)) {
        return mod.map((m) => (typeof m === "string" ? m : "")).filter(Boolean);
      }
      if (typeof mod === "string") return [mod];
    }

    return [];
  }

  // Extract properties
  private extractProperties(
    project: Record<string, unknown>,
  ): Record<string, string> {
    const properties = project.properties as Record<string, unknown>;
    if (!properties) return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  }

  // Extract dependency management entries
  extractDependencyManagement(
    pomData: Record<string, unknown>,
  ): DependencyManagementEntry[] {
    const project = (pomData.project as Record<string, unknown>) || {};
    const dependencyManagement = project.dependencyManagement as Record<
      string,
      unknown
    >;
    if (!dependencyManagement) return [];

    const dependencies = (
      dependencyManagement.dependencies as Record<string, unknown>
    )?.dependency as Array<Record<string, unknown>>;
    if (!dependencies) return [];

    return dependencies.map((dep) => ({
      groupId: this.extractValue(dep, "groupId") || "",
      artifactId: this.extractValue(dep, "artifactId") || "",
      version: this.extractValue(dep, "version") || "",
      scope: this.extractValue(dep, "scope") as DependencyScope | undefined,
      type: this.extractValue(dep, "type") || undefined,
    }));
  }

  // Extract dependencies
  extractDependencies(pomData: Record<string, unknown>): Array<{
    groupId: string;
    artifactId: string;
    version?: string;
    scope: string;
    type?: string;
    optional?: boolean;
    exclusions?: Array<{ groupId: string; artifactId: string }>;
  }> {
    const project = (pomData.project as Record<string, unknown>) || {};
    const dependencies = this.getDependencyArray(project);
    if (!dependencies) return [];

    return dependencies.map((dep) => ({
      groupId: this.extractValue(dep, "groupId") || "",
      artifactId: this.extractValue(dep, "artifactId") || "",
      version: this.extractValue(dep, "version") || undefined,
      scope: this.extractValue(dep, "scope") || "compile",
      type: this.extractValue(dep, "type") || undefined,
      optional: this.extractValue(dep, "optional") === "true",
      exclusions: this.extractExclusions(dep),
    }));
  }

  // Extract exclusions
  private extractExclusions(
    dep: Record<string, unknown>,
  ): Array<{ groupId: string; artifactId: string }> {
    const exclusions = dep.exclusions as Record<string, unknown>;
    if (!exclusions) return [];

    const exclusion = exclusions.exclusion as Array<Record<string, unknown>>;
    if (!exclusion) return [];

    return exclusion.map((excl) => ({
      groupId: this.extractValue(excl, "groupId") || "",
      artifactId: this.extractValue(excl, "artifactId") || "",
    }));
  }

  // Extract Spring Boot version from properties or parent
  extractSpringBootVersion(pomData: Record<string, unknown>): string | null {
    const project = (pomData.project as Record<string, unknown>) || {};
    const properties = project.properties as Record<string, unknown>;

    // Check properties for spring-boot.version
    if (properties) {
      const version =
        properties["spring-boot.version"] || properties["spring.boot.version"];
      if (typeof version === "string") return version;
    }

    // Check parent
    const parent = project.parent as Record<string, unknown>;
    if (parent) {
      const artifactId = this.extractValue(parent, "artifactId");
      if (
        artifactId === "spring-boot-starter-parent" ||
        artifactId === "spring-boot-dependencies"
      ) {
        return this.extractValue(parent, "version");
      }
    }

    return null;
  }

  // Update dependency version in POM (synchronous mutation of in-memory data)
  updateDependencyVersion(
    pomData: Record<string, unknown>,
    groupId: string,
    artifactId: string,
    newVersion: string,
  ): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};

    // Check in dependencies
    const dependencies = this.getDependencyArray(project);
    if (dependencies) {
      for (const dep of dependencies) {
        if (this.matchesDependency(dep, groupId, artifactId)) {
          const version = this.extractValue(dep, "version");
          // If the version is a property reference like ${x.version}, update
          // the property instead of the literal — otherwise the change is
          // ignored by Maven (the property still resolves to the old value).
          if (version && version.startsWith("${") && version.endsWith("}")) {
            const propName = version.slice(2, -1);
            if (this.updateProperty(pomData, propName, newVersion)) {
              log.info(
                `Updated property ${propName} (for ${groupId}:${artifactId}) to ${newVersion}`,
              );
              return true;
            }
            log.warn(
              `Dependency ${groupId}:${artifactId} uses property ${propName} which is not defined in this POM`,
            );
            return false;
          }
          dep.version = newVersion;
          log.info(
            `Updated dependency ${groupId}:${artifactId} to ${newVersion}`,
          );
          return true;
        }
      }
    }

    // Check in dependencyManagement (versions may be managed centrally)
    const depMgmt = project.dependencyManagement as Record<string, unknown>;
    const depMgmtInner = depMgmt?.dependencies as
      | Record<string, unknown>
      | undefined;
    const managedDeps = depMgmtInner?.dependency as
      | Array<Record<string, unknown>>
      | undefined;
    if (managedDeps) {
      for (const dep of managedDeps) {
        if (this.matchesDependency(dep, groupId, artifactId)) {
          const version = this.extractValue(dep, "version");
          if (version && version.startsWith("${") && version.endsWith("}")) {
            const propName = version.slice(2, -1);
            if (this.updateProperty(pomData, propName, newVersion)) {
              log.info(
                `Updated property ${propName} (for managed ${groupId}:${artifactId}) to ${newVersion}`,
              );
              return true;
            }
            log.warn(
              `Managed dependency ${groupId}:${artifactId} uses property ${propName} which is not defined in this POM`,
            );
            return false;
          }
          dep.version = newVersion;
          log.info(
            `Updated managed dependency ${groupId}:${artifactId} to ${newVersion}`,
          );
          return true;
        }
      }
    }

    return false;
  }

  // Update parent version (synchronous mutation of in-memory data)
  updateParentVersion(
    pomData: Record<string, unknown>,
    newVersion: string,
  ): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};
    const parent = project.parent as Record<string, unknown>;

    if (parent) {
      parent.version = newVersion;
      log.info(`Updated parent version to ${newVersion}`);
      return true;
    }

    return false;
  }

  // Update property value (synchronous mutation of in-memory data)
  updateProperty(
    pomData: Record<string, unknown>,
    propertyName: string,
    newValue: string,
  ): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};
    const properties = project.properties as Record<string, unknown>;

    if (properties && propertyName in properties) {
      properties[propertyName] = newValue;
      log.info(`Updated property ${propertyName} to ${newValue}`);
      return true;
    }

    return false;
  }

  // Add exclusion to a dependency (synchronous mutation of in-memory data)
  addExclusion(
    pomData: Record<string, unknown>,
    groupId: string,
    artifactId: string,
    exclusionGroupId: string,
    exclusionArtifactId: string,
  ): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};
    const dependencies = this.getDependencyArray(project);

    if (!dependencies) return false;

    for (const dep of dependencies) {
      if (this.matchesDependency(dep, groupId, artifactId)) {
        let exclusions = dep.exclusions as Record<string, unknown>;
        if (!exclusions) {
          exclusions = { exclusion: [] };
          dep.exclusions = exclusions;
        }

        let exclusionArray = exclusions.exclusion as Array<
          Record<string, unknown>
        >;
        if (!Array.isArray(exclusionArray)) {
          exclusionArray = [];
          exclusions.exclusion = exclusionArray;
        }

        // Check if exclusion already exists
        const exists = exclusionArray.some(
          (e) =>
            this.extractValue(e, "groupId") === exclusionGroupId &&
            this.extractValue(e, "artifactId") === exclusionArtifactId,
        );

        if (!exists) {
          exclusionArray.push({
            groupId: exclusionGroupId,
            artifactId: exclusionArtifactId,
          });
          log.info(
            `Added exclusion ${exclusionGroupId}:${exclusionArtifactId} to ${groupId}:${artifactId}`,
          );
          return true;
        }

        return false; // Already exists
      }
    }

    return false;
  }

  // Remove dependency (synchronous mutation of in-memory data)
  removeDependency(
    pomData: Record<string, unknown>,
    groupId: string,
    artifactId: string,
  ): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};
    const dependencies = this.getDependencyArray(project);

    if (!dependencies) return false;

    const index = dependencies.findIndex((dep) =>
      this.matchesDependency(dep, groupId, artifactId),
    );
    if (index >= 0) {
      dependencies.splice(index, 1);
      log.info(`Removed dependency ${groupId}:${artifactId}`);
      return true;
    }

    return false;
  }

  // Add dependency (synchronous mutation of in-memory data)
  addDependency(
    pomData: Record<string, unknown>,
    groupId: string,
    artifactId: string,
    version: string,
    scope: string = "compile",
  ): void {
    const project = (pomData.project as Record<string, unknown>) || {};

    // Ensure the dependencies wrapper is attached to the project object.
    // Without this, creating a local wrapper means the dependency is
    // silently lost when the POM is written back.
    if (!project.dependencies) {
      project.dependencies = { dependency: [] };
    }
    const depsWrapper = project.dependencies as Record<string, unknown>;
    if (!depsWrapper.dependency) {
      depsWrapper.dependency = [];
    }

    const dependencies = depsWrapper.dependency as Array<
      Record<string, unknown>
    >;
    dependencies.push({
      groupId,
      artifactId,
      version,
      scope,
    });

    log.info(`Added dependency ${groupId}:${artifactId}:${version}`);
  }

  // Helper to match a dependency
  private matchesDependency(
    dep: Record<string, unknown>,
    groupId: string,
    artifactId: string,
  ): boolean {
    return (
      this.extractValue(dep, "groupId") === groupId &&
      this.extractValue(dep, "artifactId") === artifactId
    );
  }

  // Helper to get the dependency array from parsed POM data.
  // fast-xml-parser produces { dependencies: { dependency: [...] } }, not
  // { dependencies: [...] }. This helper unwraps the intermediate object.
  private getDependencyArray(
    project: Record<string, unknown>,
  ): Array<Record<string, unknown>> | undefined {
    const deps = project.dependencies as Record<string, unknown> | undefined;
    if (!deps) return undefined;
    const arr = deps.dependency as Array<Record<string, unknown>> | undefined;
    return arr;
  }

  // Helper to extract string value
  private extractValue(
    obj: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = obj[key];
    if (typeof value === "string") return value;
    return null;
  }

  // Find pom.xml files in a project (truly async)
  async findPomFiles(projectPath: string): Promise<string[]> {
    const pomFiles: string[] = [];
    const rootPom = join(projectPath, "pom.xml");

    if (await fileExists(rootPom)) {
      pomFiles.push(rootPom);
    }

    // Check for multi-module
    try {
      const rootPomData = await this.readPom(rootPom);
      const modules = this.extractModules(rootPomData);

      for (const module of modules) {
        const modulePom = join(projectPath, module, "pom.xml");
        if (await fileExists(modulePom)) {
          pomFiles.push(modulePom);
        }
      }
    } catch {
      // Ignore errors, just return what we found
    }

    return pomFiles;
  }

  // Check if a property is defined in POM
  hasProperty(pomData: Record<string, unknown>, propertyName: string): boolean {
    const project = (pomData.project as Record<string, unknown>) || {};
    const properties = project.properties as Record<string, unknown>;
    return properties ? propertyName in properties : false;
  }

  // Get property value from POM
  getProperty(
    pomData: Record<string, unknown>,
    propertyName: string,
  ): string | null {
    const project = (pomData.project as Record<string, unknown>) || {};
    const properties = project.properties as Record<string, unknown>;
    if (!properties) return null;

    const value = properties[propertyName];
    return typeof value === "string" ? value : null;
  }
}
