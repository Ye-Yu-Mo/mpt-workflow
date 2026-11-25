/**
 * Shared domain types for the workflow tool.
 *
 * Source of truth for state lives in Markdown (PLAN.md / TODO-Mn.md /
 * docs/agent-questions.md). Everything here is a derived, in-memory view.
 */

export type Role = 'main' | 'plan' | 'todo' | 'user';

export const ROLES: readonly Role[] = ['main', 'plan', 'todo', 'user'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export type MilestoneStatus =
  | 'planned'
  | 'todo_ready'
  | 'implementing'
  | 'review'
  | 'accepted'
  | 'rejected'
  | 'committed';

export type QuestionStatus = 'open' | 'answered' | 'applied' | 'closed' | 'canceled';

export type PhaseStatus = 'planned' | 'active' | 'accepted' | 'done';

export interface RepoConfig {
  id: string;
  path: string;
  branch?: string;
  role?: string;
  notes?: string;
}

export interface PhaseConfig {
  id: string;
  title: string;
  status: PhaseStatus;
  repos: string[];
  exit_criteria?: string[];
}

export interface ContractConfig {
  name: string;
  ref: string;
  pinned_sha?: string | null;
  repos?: string[];
}

export interface ProgramConfig {
  program: string;
  root: string;
  repos: RepoConfig[];
  phases: PhaseConfig[];
  active_repo: string | null;
  contracts: ContractConfig[];
}

export interface OptionItem {
  id: string;
  text: string;
}

export interface Question {
  id: string;
  status: QuestionStatus;
  to: Role | string;
  from: Role | string;
  blocking: boolean;
  blockingRaw: string;
  date?: string;
  context: string;
  options: OptionItem[];
  recommendation?: string;
  answer?: string;
  resolution?: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  repo?: string;
}

export interface EvidenceItem {
  id: string;
  at: string;
  command: string;
  exitCode: number;
  head: string;
  tree: string;
  dirty: boolean;
  outputTail: string;
}

export interface TodoDoc {
  id: string;
  file: string;
  title: string;
  status: MilestoneStatus;
  statusRaw: string;
  planRef?: string;
  phase?: string;
  sha?: string;
  allowedFiles: string[];
  acceptance: string[];
  body: string;
  frontMatter: Record<string, unknown>;
}

export interface MilestoneState {
  id: string;
  title: string;
  status: MilestoneStatus;
  statusRaw: string;
  repo: string;
  todoFile?: string;
  sha?: string;
  acceptance: string[];
  evidence: EvidenceItem[];
  planRef?: string;
}

export interface GitInfo {
  available: boolean;
  branch: string;
  head: string;
  shortHead: string;
  dirty: boolean;
  changed: string[];
  untracked: string[];
  error?: string;
}

export interface RepoState {
  id: string;
  path: string;
  absPath: string;
  branch?: string;
  phase?: string;
  plan?: {
    file: string;
    title: string;
    version?: string;
    statusRaw?: string;
    phase?: string;
    milestoneIds: string[];
  };
  milestones: MilestoneState[];
  currentMilestone: MilestoneState | null;
  questions: Question[];
  git: GitInfo;
  problems: string[];
}

export interface NextAction {
  actor: Role;
  action: string;
  detail: string;
  repo?: string;
  milestone?: string;
  question?: string;
  blocking: boolean;
}

export interface ProgramStatus {
  program: string;
  root: string;
  activeRepo: string | null;
  phases: PhaseConfig[];
  repos: RepoState[];
  questions: Question[];
  blockingQuestions: Question[];
  next: NextAction[];
  generatedAt: string;
}

export interface DoctorFinding {
  level: 'OK' | 'WARN' | 'FAIL';
  code: string;
  message: string;
  hint?: string;
  repo?: string;
}

export interface EvidenceRecord {
  item: EvidenceItem;
  fullOutputPath?: string;
}
