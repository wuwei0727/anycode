import React, { createContext, useContext, useState, useCallback, useEffect, ReactNode, useRef } from 'react';
import { api, Project, Session, UnifiedProject, EngineFilter } from '@/lib/api';
import { mergeProjects, filterProjectsByEngine } from '@/lib/projectMerger';
import { useTranslation } from 'react-i18next';

interface ProjectContextType {
  /** Raw Claude projects (for backward compatibility) */
  projects: Project[];
  /** Unified projects from all engines */
  unifiedProjects: UnifiedProject[];
  /** Filtered unified projects based on engine filter */
  filteredProjects: UnifiedProject[];
  /** Current engine filter */
  engineFilter: EngineFilter;
  /** Set engine filter */
  setEngineFilter: (filter: EngineFilter) => void;
  selectedProject: Project | null;
  /** Selected unified project */
  selectedUnifiedProject: UnifiedProject | null;
  sessions: Session[];
  loading: boolean;
  error: string | null;
  loadProjects: () => Promise<void>;
  selectProject: (project: Project) => Promise<void>;
  /** Select a unified project */
  selectUnifiedProject: (project: UnifiedProject) => Promise<void>;
  refreshSessions: () => Promise<void>;
  deleteProject: (project: Project) => Promise<void>;
  clearSelection: () => void;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

export const ProjectProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [unifiedProjects, setUnifiedProjects] = useState<UnifiedProject[]>([]);
  // 默认筛选：Codex（按需求每次打开默认选择 Codex）
  const [engineFilter, setEngineFilter] = useState<EngineFilter>('codex');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedUnifiedProject, setSelectedUnifiedProject] = useState<UnifiedProject | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionsCacheRef = useRef<Map<string, Session[]>>(new Map());
  const sessionsRequestRef = useRef(0);

  const normalizeProjectPath = useCallback((path: string) => {
    return path.trim().replace(/\\/g, '/').toLowerCase();
  }, []);

  // Compute filtered projects based on engine filter
  const filteredProjects = filterProjectsByEngine(unifiedProjects, engineFilter);

  const loadProjects = useCallback(async () => {
    try {
      const hasCachedProjects = unifiedProjects.length > 0 || projects.length > 0;
      if (!hasCachedProjects) {
        setLoading(true);
      }
      setError(null);

      // Load Claude and Codex projects in parallel
      const [claudeProjects, codexProjects] = await Promise.all([
        api.listProjects(),
        api.listCodexProjects().catch(err => {
          console.warn('[ProjectContext] Failed to load Codex projects:', err);
          return [];
        })
      ]);

      console.log('[ProjectContext] Loaded Claude projects:', claudeProjects.length);
      console.log('[ProjectContext] Loaded Codex projects:', codexProjects.length);

      // Store raw Claude projects for backward compatibility
      setProjects(claudeProjects);

      // Merge projects from all engines
      const merged = mergeProjects(claudeProjects, codexProjects);
      console.log('[ProjectContext] Merged unified projects:', merged.length);
      setUnifiedProjects(merged);
    } catch (err) {
      console.error("Failed to load projects:", err);
      setError(t('common.loadingProjects'));
    } finally {
      setLoading(false);
    }
  }, [t, unifiedProjects.length, projects.length]);

  const selectProject = useCallback(async (project: Project) => {
    console.log('[ProjectContext] selectProject called with:', project.id, project.path);
    try {
      const requestId = ++sessionsRequestRef.current;
      const cacheKey = normalizeProjectPath(project.path);
      const cachedSessions = sessionsCacheRef.current.get(cacheKey);

      setLoading(true);
      setError(null);
      setSelectedProject(project);
      setSelectedUnifiedProject(null);
      setSessions(cachedSessions ?? []);
      console.log('[ProjectContext] selectedProject set, loading sessions in parallel...');

      // Load Claude/Codex and Gemini sessions in parallel
      const [claudeCodexSessions, geminiResult] = await Promise.all([
        api.getProjectSessions(project.id, project.path),
        api.listGeminiSessions(project.path).catch(err => {
          console.warn('[ProjectContext] Failed to load Gemini sessions:', err);
          return [] as import('@/types/gemini').GeminiSessionInfo[];
        })
      ]);

      if (requestId !== sessionsRequestRef.current) return;
      console.log('[ProjectContext] Claude/Codex sessions loaded:', claudeCodexSessions.length);

      // Convert GeminiSessionInfo to Session format
      const geminiSessions: Session[] = geminiResult.map(info => ({
        id: info.sessionId,
        project_id: project.id,
        project_path: project.path,
        created_at: new Date(info.startTime).getTime() / 1000,
        first_message: info.firstMessage,
        message_timestamp: info.startTime,
        last_message_timestamp: info.startTime,
        engine: 'gemini' as const,
      }));

      const allSessions = [...claudeCodexSessions, ...geminiSessions];
      console.log('[ProjectContext] Loaded sessions:', allSessions.length);
      setSessions(allSessions);
      sessionsCacheRef.current.set(cacheKey, allSessions);

      // Background indexing
      api.preindexProject(project.path).catch(console.error);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      setError(t('common.loadingSessions'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const selectUnifiedProject = useCallback(async (project: UnifiedProject) => {
    console.log('[ProjectContext] selectUnifiedProject called with:', project.path);
    try {
      const requestId = ++sessionsRequestRef.current;
      const cacheKey = normalizeProjectPath(project.path);
      const cachedSessions = sessionsCacheRef.current.get(cacheKey);

      setLoading(true);
      setError(null);
      setSelectedUnifiedProject(project);

      // Find corresponding Claude project if exists
      const claudeProject = projects.find(p => 
        p.path.toLowerCase().replace(/\\/g, '/') === project.path.toLowerCase().replace(/\\/g, '/')
      );
      setSelectedProject(claudeProject || null);

      setSessions(cachedSessions ?? []);
      console.log('[ProjectContext] Loading sessions for unified project...');

      // Load sessions from all engines in parallel
      const sessionPromises: Promise<Session[]>[] = [];

      // Claude/Codex sessions (if Claude project exists)
      if (claudeProject) {
        sessionPromises.push(
          api.getProjectSessions(claudeProject.id, project.path)
        );
      } else if (project.engines.codex) {
        // Codex-only project: load Codex sessions directly
        sessionPromises.push(
          api.listCodexSessionsForProject(project.path).then(codexSessions => 
            codexSessions.map(cs => ({
              id: cs.id,
              project_id: '',
              project_path: cs.projectPath,
              created_at: cs.createdAt,
              model: cs.model || 'gpt-5.1-codex-max',
              engine: 'codex' as const,
              first_message: cs.firstMessage || 'Codex Session',
              last_assistant_message: cs.lastAssistantMessage,
              last_message_timestamp: cs.lastMessageTimestamp,
            }))
          )
        );
      }

      // Gemini sessions
      sessionPromises.push(
        api.listGeminiSessions(project.path).then(geminiResult => 
          geminiResult.map(info => ({
            id: info.sessionId,
            project_id: claudeProject?.id || '',
            project_path: project.path,
            created_at: new Date(info.startTime).getTime() / 1000,
            first_message: info.firstMessage,
            message_timestamp: info.startTime,
            last_message_timestamp: info.startTime,
            engine: 'gemini' as const,
          }))
        ).catch(err => {
          console.warn('[ProjectContext] Failed to load Gemini sessions:', err);
          return [] as Session[];
        })
      );

      const results = await Promise.all(sessionPromises);
      if (requestId !== sessionsRequestRef.current) return;
      const allSessions = results.flat();

      // Sort by created_at descending
      allSessions.sort((a, b) => b.created_at - a.created_at);

      console.log('[ProjectContext] Loaded sessions:', allSessions.length);
      setSessions(allSessions);
      sessionsCacheRef.current.set(cacheKey, allSessions);

      // Background indexing
      api.preindexProject(project.path).catch(console.error);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      setError(t('common.loadingSessions'));
    } finally {
      setLoading(false);
    }
  }, [t, projects]);

  const refreshSessions = useCallback(async () => {
    const project = selectedUnifiedProject || selectedProject;
    if (!project) return;

    try {
      const projectPath = 'path' in project ? project.path : (project as Project).path;
      const cacheKey = normalizeProjectPath(projectPath);
      const projectId = selectedProject?.id || '';

      const [claudeCodexSessions, geminiResult] = await Promise.all([
        projectId ? api.getProjectSessions(projectId, projectPath) : 
          api.listCodexSessionsForProject(projectPath).then(codexSessions => 
            codexSessions.map(cs => ({
              id: cs.id,
              project_id: '',
              project_path: cs.projectPath,
              created_at: cs.createdAt,
              model: cs.model || 'gpt-5.1-codex-max',
              engine: 'codex' as const,
              first_message: cs.firstMessage || 'Codex Session',
              last_assistant_message: cs.lastAssistantMessage,
              last_message_timestamp: cs.lastMessageTimestamp,
            }))
          ),
        api.listGeminiSessions(projectPath).catch(() => [] as import('@/types/gemini').GeminiSessionInfo[])
      ]);

      const geminiSessions: Session[] = geminiResult.map(info => ({
        id: info.sessionId,
        project_id: projectId,
        project_path: projectPath,
        created_at: new Date(info.startTime).getTime() / 1000,
        first_message: info.firstMessage,
        message_timestamp: info.startTime,
        last_message_timestamp: info.startTime,
        engine: 'gemini' as const,
      }));

      const allSessions = [...claudeCodexSessions, ...geminiSessions];
      allSessions.sort((a, b) => b.created_at - a.created_at);
      setSessions(allSessions);
      sessionsCacheRef.current.set(cacheKey, allSessions);
    } catch (err) {
      console.error("Failed to refresh sessions:", err);
    }
  }, [selectedProject, selectedUnifiedProject, normalizeProjectPath]);

  const deleteProject = useCallback(async (project: Project) => {
    try {
      setLoading(true);
      await api.deleteProject(project.id);
      await loadProjects();
      sessionsCacheRef.current.delete(normalizeProjectPath(project.path));
      if (selectedProject?.id === project.id) {
        setSelectedProject(null);
        setSelectedUnifiedProject(null);
        setSessions([]);
      }
    } catch (err) {
      console.error("Failed to delete project:", err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [loadProjects, selectedProject, normalizeProjectPath]);

  const clearSelection = useCallback(() => {
    setSelectedProject(null);
    setSelectedUnifiedProject(null);
    setSessions([]);
  }, []);

  // Load projects on mount
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <ProjectContext.Provider value={{
      projects,
      unifiedProjects,
      filteredProjects,
      engineFilter,
      setEngineFilter,
      selectedProject,
      selectedUnifiedProject,
      sessions,
      loading,
      error,
      loadProjects,
      selectProject,
      selectUnifiedProject,
      refreshSessions,
      deleteProject,
      clearSelection
    }}>
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};
