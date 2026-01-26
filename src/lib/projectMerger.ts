/**
 * Project Merger Module
 * 
 * Merges projects from multiple engines (Claude, Codex, Gemini) into a unified view.
 */

import type { Project, CodexProject, UnifiedProject, EngineFilter } from './api';

/**
 * Normalizes a path for comparison
 * - Converts backslashes to forward slashes
 * - Removes trailing slashes
 * - Converts to lowercase
 */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Extracts the project name from a path (last segment)
 */
export function getProjectName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || normalized;
}

/**
 * Merges projects from multiple engines into a unified list
 * Projects with the same normalized path are merged into a single entry
 */
export function mergeProjects(
  claudeProjects: Project[],
  codexProjects: CodexProject[]
): UnifiedProject[] {
  const projectMap = new Map<string, UnifiedProject>();

  // Process Claude projects
  for (const project of claudeProjects) {
    const normalizedPath = normalizePath(project.path);
    const existing = projectMap.get(normalizedPath);

    if (existing) {
      // Merge with existing project
      existing.engines.claude = {
        projectId: project.id,
        sessionCount: project.sessions.length,
      };
      existing.totalSessions += project.sessions.length;
      if (project.created_at > existing.lastActivity) {
        existing.lastActivity = project.created_at;
      }
    } else {
      // Create new unified project
      projectMap.set(normalizedPath, {
        path: project.path,
        name: getProjectName(project.path),
        lastActivity: project.created_at,
        engines: {
          claude: {
            projectId: project.id,
            sessionCount: project.sessions.length,
          },
        },
        totalSessions: project.sessions.length,
      });
    }
  }

  // Process Codex projects
  for (const project of codexProjects) {
    const normalizedPath = normalizePath(project.projectPath);
    const existing = projectMap.get(normalizedPath);

    if (existing) {
      // Merge with existing project
      existing.engines.codex = {
        sessionCount: project.sessionCount,
      };
      existing.totalSessions += project.sessionCount;
      if (project.lastActivity > existing.lastActivity) {
        existing.lastActivity = project.lastActivity;
      }
    } else {
      // Create new unified project (Codex-only)
      projectMap.set(normalizedPath, {
        path: project.projectPath,
        name: getProjectName(project.projectPath),
        lastActivity: project.lastActivity,
        engines: {
          codex: {
            sessionCount: project.sessionCount,
          },
        },
        totalSessions: project.sessionCount,
      });
    }
  }

  // Convert to array and sort by last activity (newest first)
  const projects = Array.from(projectMap.values());
  projects.sort((a, b) => b.lastActivity - a.lastActivity);

  return projects;
}

/**
 * Filters projects by engine
 * - 'all': Returns all projects
 * - 'claude': Returns projects with Claude sessions
 * - 'codex': Returns projects with Codex sessions
 * - 'gemini': Returns projects with Gemini sessions
 */
export function filterProjectsByEngine(
  projects: UnifiedProject[],
  filter: EngineFilter
): UnifiedProject[] {
  if (filter === 'all') {
    return projects;
  }

  return projects.filter(project => {
    switch (filter) {
      case 'claude':
        return project.engines.claude && project.engines.claude.sessionCount > 0;
      case 'codex':
        return project.engines.codex && project.engines.codex.sessionCount > 0;
      case 'gemini':
        return project.engines.gemini && project.engines.gemini.sessionCount > 0;
      default:
        return true;
    }
  });
}

/**
 * Adds Gemini session count to a unified project
 * Called after checking Gemini sessions for a specific project path
 */
export function addGeminiSessionCount(
  project: UnifiedProject,
  sessionCount: number
): UnifiedProject {
  if (sessionCount <= 0) {
    return project;
  }

  return {
    ...project,
    engines: {
      ...project.engines,
      gemini: {
        sessionCount,
      },
    },
    totalSessions: project.totalSessions + sessionCount,
  };
}
