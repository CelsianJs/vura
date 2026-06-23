import type { ApiRoute, PageRoute, RouteManifest } from '@celsian/vura-core';

export type RuntimeProfile = 'static' | 'cold' | 'hot' | 'task-cold' | 'cron-cold' | 'task-hot' | 'cron-hot';

export interface RuntimeRouteInspection {
  type: 'api' | 'page';
  pattern: string;
  filePath: string;
  sourceIntent: string;
  effectiveProfile: RuntimeProfile;
  backingTarget: string;
  methods?: string[];
  schedule?: string;
  hasWebsocket?: boolean;
  warnings: string[];
  nextCommand?: string;
}

export interface RuntimeAdvice {
  pattern: string;
  type: 'api' | 'page';
  currentProfile: RuntimeProfile;
  recommendation: RuntimeProfile;
  severity: 'info' | 'warn';
  reason: string;
  nextCommand?: string;
}

export interface RuntimeInspection {
  routes: RuntimeRouteInspection[];
  totals: Record<RuntimeProfile, number>;
  generatedAt: string;
}

export interface RuntimeAdviceResult {
  advice: RuntimeAdvice[];
  generatedAt: string;
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function configNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function taskNameFromPattern(urlPattern: string): string {
  return urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
}

export function profileForApiRoute(route: ApiRoute): RuntimeProfile {
  if (route.kind === 'hot') return 'hot';
  if (route.kind === 'task') return 'task-cold';
  return 'cold';
}

export function cronProfileForApiRoute(route: ApiRoute): RuntimeProfile | null {
  if (route.kind === 'task' && configString(route.config, 'schedule')) return 'cron-cold';
  return null;
}

export function profileForPageRoute(page: PageRoute): RuntimeProfile {
  if (page.mode === 'server' || page.mode === 'hybrid') return 'hot';
  return 'static';
}

function backingTargetForApiRoute(route: ApiRoute): string {
  if (route.kind === 'hot') return 'hot server';
  if (route.kind === 'task') return 'serverless task function';
  return 'serverless function';
}

function backingTargetForPageRoute(page: PageRoute): string {
  if (page.mode === 'server' || page.mode === 'hybrid') return 'hot server entry';
  return 'static asset';
}

function inspectApiRoute(route: ApiRoute): RuntimeRouteInspection[] {
  const effectiveProfile = profileForApiRoute(route);
  const schedule = configString(route.config, 'schedule');
  const warnings: string[] = [];

  if (route.hasWebsocket && route.kind !== 'hot') {
    warnings.push('WebSocket exports require kind: hot to be reachable.');
  }

  const base: RuntimeRouteInspection = {
    type: 'api',
    pattern: route.urlPattern,
    filePath: route.filePath,
    sourceIntent: `kind:${route.kind}`,
    effectiveProfile,
    backingTarget: backingTargetForApiRoute(route),
    methods: route.methods,
    schedule,
    hasWebsocket: Boolean(route.hasWebsocket),
    warnings,
    nextCommand: route.kind === 'task'
      ? `vura tasks run ${taskNameFromPattern(route.urlPattern)}`
      : undefined,
  };

  const cronProfile = cronProfileForApiRoute(route);
  if (!cronProfile) return [base];

  return [
    base,
    {
      type: 'api',
      pattern: route.urlPattern,
      filePath: route.filePath,
      sourceIntent: `schedule:${schedule}`,
      effectiveProfile: cronProfile,
      backingTarget: 'control-plane scheduler to task function',
      methods: route.methods,
      schedule,
      hasWebsocket: false,
      warnings: [],
      nextCommand: 'vura tasks list',
    },
  ];
}

function inspectPageRoute(page: PageRoute): RuntimeRouteInspection {
  return {
    type: 'page',
    pattern: page.urlPattern,
    filePath: page.filePath,
    sourceIntent: `mode:${page.mode}`,
    effectiveProfile: profileForPageRoute(page),
    backingTarget: backingTargetForPageRoute(page),
    warnings: [],
  };
}

export function inspectRuntime(manifest: RouteManifest): RuntimeInspection {
  const routes = [
    ...manifest.pages.map(inspectPageRoute),
    ...manifest.api.flatMap(inspectApiRoute),
  ].sort((a, b) => a.pattern.localeCompare(b.pattern) || a.effectiveProfile.localeCompare(b.effectiveProfile));

  const totals: Record<RuntimeProfile, number> = {
    static: 0,
    cold: 0,
    hot: 0,
    'task-cold': 0,
    'cron-cold': 0,
    'task-hot': 0,
    'cron-hot': 0,
  };

  for (const route of routes) {
    totals[route.effectiveProfile] += 1;
  }

  return { routes, totals, generatedAt: new Date().toISOString() };
}

export function adviseRuntime(manifest: RouteManifest): RuntimeAdviceResult {
  const advice: RuntimeAdvice[] = [];

  for (const page of manifest.pages) {
    const currentProfile = profileForPageRoute(page);
    if (page.mode === 'server' || page.mode === 'hybrid') {
      advice.push({
        pattern: page.urlPattern,
        type: 'page',
        currentProfile,
        recommendation: 'hot',
        severity: 'info',
        reason: `${page.mode} pages run through the hot server entry today.`,
      });
    }
  }

  for (const route of manifest.api) {
    const currentProfile = profileForApiRoute(route);
    const schedule = configString(route.config, 'schedule');
    const timeout = configNumber(route.config, 'timeout');

    if (route.hasWebsocket) {
      advice.push({
        pattern: route.urlPattern,
        type: 'api',
        currentProfile,
        recommendation: 'hot',
        severity: route.kind === 'hot' ? 'info' : 'warn',
        reason: route.kind === 'hot'
          ? 'WebSocket route is correctly placed on hot runtime.'
          : 'WebSocket exports require hot runtime to handle upgrades.',
      });
    }

    if (route.kind === 'task') {
      advice.push({
        pattern: route.urlPattern,
        type: 'api',
        currentProfile,
        recommendation: 'task-cold',
        severity: 'info',
        reason: schedule
          ? 'Scheduled task is a task-cold worker with cron-cold dispatch.'
          : 'Task route is a task-cold worker for manual or API-triggered jobs.',
        nextCommand: `vura tasks run ${taskNameFromPattern(route.urlPattern)}`,
      });

      if (schedule) {
        advice.push({
          pattern: route.urlPattern,
          type: 'api',
          currentProfile: 'cron-cold',
          recommendation: 'cron-cold',
          severity: 'info',
          reason: `Cron schedule ${schedule} dispatches to the task-cold target.`,
          nextCommand: 'vura tasks list',
        });
      }

      if (typeof timeout === 'number' && timeout > 60_000) {
        advice.push({
          pattern: route.urlPattern,
          type: 'api',
          currentProfile,
          recommendation: 'task-hot',
          severity: 'warn',
          reason: 'Task timeout exceeds 60s; task-hot is the planned placement for long-running work.',
        });
      }
    }
  }

  return { advice, generatedAt: new Date().toISOString() };
}
