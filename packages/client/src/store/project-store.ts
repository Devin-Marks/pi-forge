import { create } from "zustand";
import { api, ApiError, type Project } from "../lib/api-client";

const ACTIVE_KEY = "pi-forge/active-project-id";
const COLLAPSED_KEY = "pi-forge/collapsed-projects";

function readCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "boolean") out[k] = v;
    return out;
  } catch {
    // Private-mode storage / corrupt JSON — fall back to "all expanded".
    return {};
  }
}

function writeCollapsed(state: Record<string, boolean>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state));
}

interface ProjectState {
  projects: Project[];
  activeProjectId: string | undefined;
  collapsed: Record<string, boolean>;
  loading: boolean;
  error: string | undefined;
  load: () => Promise<void>;
  create: (name: string, path: string) => Promise<Project>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setActive: (id: string | undefined) => void;
  toggleCollapsed: (id: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  activeProjectId: localStorage.getItem(ACTIVE_KEY) ?? undefined,
  collapsed: readCollapsed(),
  loading: false,
  error: undefined,
  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const { projects } = await api.listProjects();
      const activeId = get().activeProjectId;
      const stillExists = activeId !== undefined && projects.some((p) => p.id === activeId);
      const nextActive = stillExists ? activeId : projects[0]?.id;
      if (nextActive !== activeId) {
        if (nextActive) localStorage.setItem(ACTIVE_KEY, nextActive);
        else localStorage.removeItem(ACTIVE_KEY);
      }
      set({ projects, activeProjectId: nextActive, loading: false });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof ApiError ? err.code : (err as Error).message,
      });
    }
  },
  create: async (name, path) => {
    set({ error: undefined });
    try {
      const project = await api.createProject(name, path);
      set((s) => ({ projects: [...s.projects, project], activeProjectId: project.id }));
      localStorage.setItem(ACTIVE_KEY, project.id);
      return project;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },
  rename: async (id, name) => {
    try {
      const updated = await api.renameProject(id, name);
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? updated : p)) }));
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },
  remove: async (id) => {
    try {
      await api.deleteProject(id);
      set((s) => {
        const projects = s.projects.filter((p) => p.id !== id);
        const activeProjectId = s.activeProjectId === id ? projects[0]?.id : s.activeProjectId;
        if (activeProjectId) localStorage.setItem(ACTIVE_KEY, activeProjectId);
        else localStorage.removeItem(ACTIVE_KEY);
        return { projects, activeProjectId };
      });
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },
  setActive: (id) => {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
    set({ activeProjectId: id });
  },
  toggleCollapsed: (id) => {
    set((s) => {
      const next = { ...s.collapsed, [id]: !s.collapsed[id] };
      writeCollapsed(next);
      return { collapsed: next };
    });
  },
}));

/** Selector for the active project record (or undefined). */
export function useActiveProject(): Project | undefined {
  return useProjectStore((s) =>
    s.activeProjectId === undefined
      ? undefined
      : s.projects.find((p) => p.id === s.activeProjectId),
  );
}
