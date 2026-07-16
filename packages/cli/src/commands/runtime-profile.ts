import type { ApiRoute, ComputeClass, PageRoute, RouteManifest } from '@celsian/vura-core';

export type RuntimeProfile = 'static' | 'cold' | 'hot' | 'streaming-hot' | 'task-cold' | 'cron-cold' | 'task-hot' | 'cron-hot';

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
  effectiveComputeClass?: 'function' | 'dedicated';
  requestedComputeClass?: ComputeClass;
  edgeEligibility?: 'pending';
  memory?: string | number;
  cpu?: number;
  timeout?: number;
  providerRecommendation?: 'elastic-function-provider' | 'dedicated-fly-machine' | 'cloudflare-workers-for-platforms';
  confidence?: 'high' | 'medium';
  reasons?: string[];
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

function configObject(config: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = config[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function computeForRoute(route: ApiRoute): Record<string, unknown> {
  return configObject(route.config, 'compute') ?? { class: route.kind === 'hot' ? 'dedicated' : 'function', memory: '1gb' };
}

function computeDetails(route: ApiRoute): Pick<RuntimeRouteInspection,
  'effectiveComputeClass' | 'requestedComputeClass' | 'edgeEligibility' | 'memory' | 'cpu' | 'timeout' |
  'providerRecommendation' | 'confidence' | 'reasons'> {
  const compute = computeForRoute(route);
  const effectiveComputeClass = compute.effectiveClass === 'dedicated' || compute.class === 'dedicated'
    ? 'dedicated'
    : 'function';
  const requestedComputeClass = compute.class === 'edge' || compute.requestedClass === 'edge'
    ? 'edge'
    : effectiveComputeClass;
  const effectiveMemory = compute.effectiveMemory ?? compute.memory;
  const memory = typeof effectiveMemory === 'string' || typeof effectiveMemory === 'number'
    ? effectiveMemory
    : undefined;
  const cpu = typeof compute.cpu === 'number' ? compute.cpu : undefined;
  const timeout = configNumber(route.config, 'timeout');
  const edgeEligibility = compute.edgeEligibility === 'pending' ? 'pending' : undefined;

  if (requestedComputeClass === 'edge') {
    return {
      effectiveComputeClass,
      requestedComputeClass,
      edgeEligibility,
      memory,
      cpu,
      timeout,
      providerRecommendation: 'cloudflare-workers-for-platforms',
      confidence: 'high',
      reasons: [
        'Edge is an optimization request and remains on Function until the platform marks this endpoint eligible from observed memory/runtime telemetry.',
        'Edge has a fixed 128mb isolate ceiling; the safe fallback is Function at 1gb.',
      ],
    };
  }

  if (effectiveComputeClass === 'dedicated') {
    return {
      effectiveComputeClass,
      requestedComputeClass,
      memory,
      cpu,
      timeout,
      providerRecommendation: 'dedicated-fly-machine',
      confidence: 'high',
      reasons: [route.hasWebsocket
        ? 'WebSocket upgrades require persistent Dedicated compute.'
        : 'The route explicitly requests persistent Dedicated compute.'],
    };
  }

  return {
    effectiveComputeClass,
    requestedComputeClass,
    memory,
    cpu,
    timeout,
    providerRecommendation: 'elastic-function-provider',
    confidence: 'medium',
    reasons: ['Stateless endpoints and tasks default to scale-to-zero Function compute at 1gb.'],
  };
}

function prefersHotTask(config: Record<string, unknown>): boolean {
  return configObject(config, 'compute')?.class === 'dedicated'
    || ['runtime', 'placement', 'target'].some((key) => configString(config, key) === 'hot')
    || config.hot === true;
}

export function taskNameFromPattern(urlPattern: string): string {
  return urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
}

export function profileForApiRoute(route: ApiRoute): RuntimeProfile {
  if (route.kind === 'hot') return route.hasWebsocket ? 'streaming-hot' : 'hot';
  if (route.kind === 'task') return prefersHotTask(route.config) ? 'task-hot' : 'task-cold';
  return 'cold';
}

export function cronProfileForApiRoute(route: ApiRoute): RuntimeProfile | null {
  if (route.kind === 'task' && configString(route.config, 'schedule')) {
    return profileForApiRoute(route) === 'task-hot' ? 'cron-hot' : 'cron-cold';
  }
  return null;
}

export function profileForPageRoute(page: PageRoute): RuntimeProfile {
  if (page.mode === 'server' || page.mode === 'hybrid') return 'hot';
  return 'static';
}

function backingTargetForApiRoute(route: ApiRoute): string {
  const profile = profileForApiRoute(route);
  if (profile === 'hot' || profile === 'streaming-hot') return 'hot server';
  if (profile === 'task-hot') return 'hot task runtime';
  if (profile === 'task-cold') return 'serverless task function';
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

  const details = computeDetails(route);
  if (details.requestedComputeClass === 'edge' && details.edgeEligibility === 'pending') {
    warnings.push('Edge request is pending platform eligibility; effective runtime remains Function at 1gb.');
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
    ...details,
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
      backingTarget: cronProfile === 'cron-hot'
        ? 'control-plane scheduler to hot task runtime'
        : 'control-plane scheduler to task function',
      methods: route.methods,
      schedule,
      hasWebsocket: false,
      ...details,
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
    'streaming-hot': 0,
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
    const details = computeDetails(route);

    if (details.requestedComputeClass === 'edge') {
      advice.push({
        pattern: route.urlPattern,
        type: 'api',
        currentProfile,
        recommendation: currentProfile,
        severity: 'warn',
        reason: 'Edge request is pending measured platform eligibility; deploys continue on Function at 1gb until approved.',
      });
    }

    if (route.hasWebsocket) {
      advice.push({
        pattern: route.urlPattern,
        type: 'api',
        currentProfile,
        recommendation: 'streaming-hot',
        severity: route.kind === 'hot' ? 'info' : 'warn',
        reason: route.kind === 'hot'
          ? 'WebSocket route is correctly placed on streaming-hot runtime.'
          : 'WebSocket exports require streaming-hot runtime to handle upgrades.',
      });
    }

    if (route.kind === 'task') {
      const taskProfile = profileForApiRoute(route);
      advice.push({
        pattern: route.urlPattern,
        type: 'api',
        currentProfile,
        recommendation: taskProfile,
        severity: 'info',
        reason: taskProfile === 'task-hot'
          ? 'Task route is pinned to hot task runtime for long-running or stateful work.'
          : schedule
            ? 'Scheduled task is a task-cold worker with cron-cold dispatch.'
            : 'Task route is a task-cold worker for manual or API-triggered jobs.',
        nextCommand: `vura tasks run ${taskNameFromPattern(route.urlPattern)}`,
      });

      if (schedule) {
        const cronProfile = cronProfileForApiRoute(route) ?? 'cron-cold';
        advice.push({
          pattern: route.urlPattern,
          type: 'api',
          currentProfile: cronProfile,
          recommendation: cronProfile,
          severity: 'info',
          reason: cronProfile === 'cron-hot'
            ? `Cron schedule ${schedule} dispatches to the hot task target.`
            : `Cron schedule ${schedule} dispatches to the task-cold target.`,
          nextCommand: 'vura tasks list',
        });
      }

      if (typeof timeout === 'number' && timeout > 60_000 && taskProfile !== 'task-hot') {
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
