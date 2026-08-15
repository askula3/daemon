// Severity levels for vulnerabilities
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

// Dependency scope types
export type DependencyScope =
  | "compile"
  | "runtime"
  | "test"
  | "provided"
  | "system";

// Remediation priority levels (from design doc)
export type RemediationPriority =
  | "upgrade-spring-boot-parent"
  | "upgrade-owning-direct-dependency"
  | "upgrade-direct-dependency"
  | "apply-iq-suggestion"
  | "search-nexus-latest"
  | "override-transitive"
  | "exclude-and-replace"
  | "remove-unused";

// Task status
export type TaskStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "failed"
  | "skipped"
  | "rolled-back";

// Capabilities detected in the project
export interface ProjectCapabilities {
  hasMaven: boolean;
  hasMavenWrapper: boolean;
  hasSpringBoot: boolean;
  isMultiModule: boolean;
  hasGit: boolean;
  hasIQConfig: boolean;
  hasNexusConfig: boolean;
}

// Project information from inspection
export interface ProjectInfo {
  projectPath: string;
  gitBranch: string;
  gitRevision: string; // HEAD commit hash
  isClean: boolean; // working-tree has no uncommitted changes
  modifiedFiles: string[]; // list of modified/untracked files in working tree
  applicationId: string;
  rootPomPath: string;
  rootPomContent: string;
  modules: string[];
  javaVersion: string;
  springBootVersion: string | null;
  springBootParentVersion: string | null;
  parentGroupId: string | null;
  parentArtifactId: string | null;
  parentVersion: string | null;
  dependencyManagement: DependencyManagementEntry[];
  capabilities: ProjectCapabilities;
  timestamp: string;
}

// Dependency management entry
export interface DependencyManagementEntry {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: DependencyScope;
  type?: string;
}

// Vulnerability from IQ report
export interface Vulnerability {
  id: string;
  referenceUrl: string;
  description: string;
  severity: Severity;
  cvssScore: number;
  CWEs: string[];
  licenseRisk: boolean;
  componentDisplayName: string;
  pathNames: string[];
  suggestedVersion?: string;
  suggestedVersionUrl?: string;
  fixVersions: string[];
  firstPublished: string;
  lastModified: string;
}

// Component from IQ report
export interface Component {
  packageUrl: string;
  displayName: string;
  version: string;
  groupId: string;
  artifactId: string;
  extension: string;
  vulnerabilities: Vulnerability[];
}

// IQ Report structure
export interface IQReport {
  reportId: string;
  applicationId: string;
  scanId: string;
  scanTime: string;
  components: Component[];
  totalVulnerabilities: number;
  vulnerabilitiesBySeverity: Record<Severity, number>;
}

// Dependency node in the graph
export interface DependencyNode {
  packageUrl: string;
  groupId: string;
  artifactId: string;
  version: string;
  scope: DependencyScope;
  isDirect: boolean;
  isManagedBySpringBoot: boolean;
  isDeclaredInDependencyManagement: boolean;
  importedBy: string[]; // parent dependency PIDs
  children: string[]; // transitive dependencies
  vulnerabilities: Vulnerability[];
  isUsed: boolean;
  depth: number;
}

// Complete dependency graph
export interface DependencyGraph {
  nodes: Map<string, DependencyNode>;
  directDependencies: string[];
  transitiveDependencies: string[];
  springBootManaged: string[];
  vulnerableComponents: string[];
}

// Single remediation task
export interface RemediationTask {
  id: string;
  priority: RemediationPriority;
  description: string;
  component: {
    groupId: string;
    artifactId: string;
    currentVersion: string;
    targetVersion: string;
  };
  reason: string;
  expectedFixes: string[]; // vulnerability IDs that will be fixed
  confidence: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  preconditions: string[];
  verification: string[];
  rollbackSteps: string[];
  dependencies: string[]; // task IDs that must complete first
  status: TaskStatus;
  module?: string; // for multi-module projects
  pomPath?: string;
  metadata?: {
    ownerGroupId?: string; // owning dependency groupId (for exclude-and-replace)
    ownerArtifactId?: string; // owning dependency artifactId
    [key: string]: unknown;
  };
}

// Execution plan (DAG)
export interface ExecutionPlan {
  id: string;
  projectId: string;
  previousPlanId?: string; // Set during replan — tracks lineage for audit
  tasks: RemediationTask[];
  batches: RemediationTask[][]; // tasks grouped by dependency level
  estimatedDuration: string;
  riskAssessment: "low" | "medium" | "high";
  summary: string;
  createdAt: string;
  policyUsed: PolicyConfig;
  vulnerabilitiesBySeverity: SummaryCount; // severity breakdown from IQ report
  // Plan immutability fields (spec §21)
  gitRevision: string; // Git HEAD at plan creation time
  projectFingerprint: string; // SHA-256 of key project files
  policyHash: string; // SHA-256 of serialized PolicyConfig
}

// Policy configuration
export interface PolicyConfig {
  severity: Severity[];
  preferParentUpgrade: boolean;
  preferOwningDependency: boolean;
  preferIqSuggestion: boolean;
  removeUnused: boolean;
  allowPatch: boolean;
  allowMinor: boolean;
  allowMajor: boolean;
  allowSnapshots: boolean;
  allowRedhat: boolean;
  verifyBuild: boolean;
  verifyIq: boolean;
  maxBatchSize?: number;
  timeout?: number;
  // Execution limits (spec §39 — prevent infinite loops)
  maxReplans?: number; // default: 3
  maxBatches?: number; // default: 10
  maxMavenFailures?: number; // default: 3
  maxModifications?: number; // default: 50
}

// Environment configuration
export interface EnvConfig {
  iqServerUrl: string;
  iqServerToken: string;
  iqAppId: string;
  iqUsername: string;
  nexusUrl: string;
  nexusUsername: string;
  nexusPassword: string;
  preferMvnw: boolean;
  mavenOpts?: string;
  logLevel: string;
}

// Execution results
export interface ExecutionResult {
  executionId: string;
  planId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed" | "partial";
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  buildSuccess: boolean;
  iqScanSuccess: boolean;
  vulnerabilitiesBefore: number;
  vulnerabilitiesAfter: number;
  vulnerabilitiesResolved: number;
  remainingVulnerabilities: number;
  vulnerabilitiesBySeverityBefore: SummaryCount;
  vulnerabilitiesBySeverityAfter: SummaryCount;
  changes: ChangeRecord[];
  errors: ErrorRecord[];
}

// Change record for a single modification
export interface ChangeRecord {
  task: string;
  pomPath: string;
  timestamp: string;
  type: "upgrade" | "add" | "remove" | "exclude";
  before: string;
  after: string;
}

// Error record
export interface ErrorRecord {
  task: string;
  phase: string;
  error: string;
  rollbackAttempted: boolean;
  rollbackSuccess: boolean;
  code?: FailureCode; // structured failure classification
}

// Structured failure codes (spec §28)
export type FailureCode =
  | "NO_FIX_AVAILABLE"
  | "POLICY_BLOCKED"
  | "VERSION_NOT_AVAILABLE"
  | "INCOMPATIBLE_UPGRADE"
  | "BUILD_FAILED"
  | "IQ_UNAVAILABLE"
  | "NEXUS_UNAVAILABLE"
  | "PROJECT_CHANGED"
  | "PLAN_INVALID"
  | "UNKNOWN";

// Summary count by severity
export interface SummaryCount {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

// Nexus search result
export interface NexusArtifact {
  group: string;
  name: string;
  version: string;
  repository: string;
  format: string;
  packaging: string;
  timestamp: string;
  classifiers: string[];
}

// Maven command result
export interface MavenResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  success: boolean;
}

// Execution state — tracks a running or completed execution
export interface ExecutionState {
  executionId: string;
  plan: ExecutionPlan;
  result: ExecutionResult;
  pomBackups: Map<string, string>; // pomPath → backupPath
  startedAt: string;
  completedAt?: string;
}

// Plan store interface
export interface IPlanStore {
  savePlan(plan: ExecutionPlan): void;
  getPlan(planId: string): ExecutionPlan | undefined;
  saveExecution(state: ExecutionState): void;
  getExecution(executionId: string): ExecutionState | undefined;
  listExecutions(): ExecutionState[];
  clear(): void;
}
