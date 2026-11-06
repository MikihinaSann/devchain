#!/usr/bin/env node
/**
 * add-devchain-project.mjs — create a DevChain project from the bundled
 * `teams-dev` template for an existing folder, without opening the UI wizard.
 *
 * Usage:
 *   node scripts/add-devchain-project.mjs <windows-or-wsl-path> [--preset "Name"] [--port 3000] [--dry-run]
 *
 * Examples:
 *   node scripts/add-devchain-project.mjs "C:\\Users\\me\\Documents\\GitHub\\foo"
 *   node scripts/add-devchain-project.mjs /mnt/c/Users/me/Documents/GitHub/foo --preset "Devin+OpenCode[alloc]"
 *   node scripts/add-devchain-project.mjs /tmp/scratch --dry-run
 *
 * Behavior:
 *   - Mirrors the create-project wizard payload: POSTs
 *     /api/projects/from-template on the local DevChain API (default
 *     http://127.0.0.1:3000) with slug "teams-dev", the folder basename as the
 *     project name, selectedProviderNames ["devin", "opencode"], the preset
 *     (default "Devin+OpenCode[alloc]"), plus the wizard-derived
 *     familyProviderMappings and teamOverrides (fetched via setup-preview).
 *   - Path handling: on Windows the path is sent unchanged; inside WSL
 *     (linux + /mnt) a Windows drive path like C:\... or C:/... is converted
 *     to /mnt/<drive>/... so the server sees a native path. POSIX paths pass
 *     through everywhere. Run the script in the same environment as the
 *     DevChain server.
 *   - --preset "Name" picks a different template preset; --preset none omits
 *     presetName entirely (template default agent configs apply).
 *   - --dry-run prints the exact payload without creating anything.
 *   - If the API answers providerMappingRequired, the script derives the
 *     family→provider mappings itself and retries once (what the wizard's
 *     mapping modal does).
 */

import fs from 'node:fs';
import process from 'node:process';

const TEMPLATE_SLUG = 'teams-dev';
const DEFAULT_PRESET = 'Devin+OpenCode[alloc]';
const DEFAULT_PORT = 3000;
const SELECTED_PROVIDERS = ['devin', 'opencode'];
const REQUEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Usage: node scripts/add-devchain-project.mjs <windows-or-wsl-path> [options]

Options:
  --preset "Name"   Template preset to apply (default: "${DEFAULT_PRESET}"); "none" omits it
  --port <n>        DevChain API port (default: ${DEFAULT_PORT})
  --dry-run         Print the payload without creating the project
  -h, --help        Show this help
`);
}

function parseArgs(argv) {
  const args = { preset: DEFAULT_PRESET, port: DEFAULT_PORT, dryRun: false, path: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--preset') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--preset requires a value');
      args.preset = value;
    } else if (arg === '--port') {
      const value = argv[++i];
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port requires a valid port number, got ${JSON.stringify(value)}`);
      }
      args.port = port;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg.startsWith('--preset=')) {
      args.preset = arg.slice('--preset='.length);
    } else if (arg.startsWith('--port=')) {
      const port = Number(arg.slice('--port='.length));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`--port requires a valid port number`);
      }
      args.port = port;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('Expected exactly one path argument');
  }
  args.path = positional[0];
  return args;
}

// ---------------------------------------------------------------------------
// Path handling
// ---------------------------------------------------------------------------

/** True when running inside WSL: linux platform with a /mnt drive mount root. */
function runningInsideWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return fs.existsSync('/mnt');
  } catch {
    return false;
  }
}

/**
 * Convert a Windows drive path (C:\... or C:/...) to its WSL mount path
 * (/mnt/c/...) when running inside WSL. POSIX paths and non-WSL hosts pass
 * through unchanged.
 */
export function toServerPath(inputPath) {
  if (!runningInsideWsl()) return inputPath;
  if (inputPath.startsWith('/')) return inputPath;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(inputPath);
  if (!match) return inputPath;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${drive}/${rest}`;
}

/** Project name = last path segment, separator-agnostic (win + posix). */
export function projectNameFromPath(inputPath) {
  const trimmed = inputPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) throw new Error(`Cannot derive a project name from path: ${inputPath}`);
  return last;
}

// ---------------------------------------------------------------------------
// Wizard-equivalent payload derivation (ports of the UI wizard helpers)
// ---------------------------------------------------------------------------

function eqName(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Port of deriveFamilyProviderMappings (wizard/providerSelection.ts): for every
 * family whose template default provider is not selected but which HAS a
 * selected available alternative, map family slug → first such alternative.
 */
function deriveFamilyProviderMappings(familyAlternatives, selectedProviderNames) {
  const selected = new Set(selectedProviderNames.map((n) => n.trim().toLowerCase()));
  const mappings = {};
  for (const family of familyAlternatives ?? []) {
    const defaultProvider = family.defaultProvider ?? '';
    if (selected.has(defaultProvider.trim().toLowerCase())) continue;
    const substitute = (family.availableProviders ?? []).find((provider) =>
      selected.has(String(provider).trim().toLowerCase()),
    );
    if (substitute) {
      mappings[String(family.familySlug ?? '').trim().toLowerCase()] = String(substitute)
        .trim()
        .toLowerCase();
    }
  }
  return mappings;
}

/**
 * Port of the wizard's default team emission (teamPlan.ts initialTeamStates +
 * buildTeamOverrides with the Step-1 provider filter): only teams with
 * allowTeamLeadCreateAgents === true are configurable; subset config names are
 * restricted to configs whose provider is in the Step-1 selection.
 */
function buildTeamOverrides(teams, profiles, selectedProviderNames) {
  const configProviders = new Map();
  for (const profile of profiles ?? []) {
    const byConfig = new Map();
    for (const pc of profile.providerConfigs ?? []) {
      byConfig.set(String(pc.name).trim().toLowerCase(), String(pc.providerName).trim().toLowerCase());
    }
    configProviders.set(String(profile.name).trim().toLowerCase(), byConfig);
  }
  const selected = new Set(selectedProviderNames.map((n) => n.trim().toLowerCase()));

  const overrides = [];
  for (const team of teams ?? []) {
    if (team.allowTeamLeadCreateAgents !== true) continue;

    const profileNames = [];
    const profileSelections = [];
    for (const profileName of team.profileNames ?? []) {
      const selection = (team.profileSelections ?? []).find((s) =>
        eqName(s.profileName, profileName),
      );
      if (selection && Array.isArray(selection.configNames) && selection.configNames.length > 0) {
        const byConfig = configProviders.get(String(profileName).trim().toLowerCase());
        const configNames = selection.configNames.filter((key) => {
          const provider = byConfig?.get(String(key).trim().toLowerCase());
          return !provider || selected.has(provider);
        });
        if (configNames.length > 0) {
          profileNames.push(profileName);
          profileSelections.push({ profileName, configNames });
        }
      } else {
        profileNames.push(profileName);
        profileSelections.push({ profileName, configNames: [] });
      }
    }

    const override = {
      teamName: team.name,
      allowTeamLeadCreateAgents: true,
      profileNames,
    };
    if (profileSelections.length > 0) override.profileSelections = profileSelections;
    overrides.push(override);
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

async function fetchSetupPreview(baseUrl) {
  const { ok, status, data } = await postJson(baseUrl, '/api/projects/setup-preview', {
    slug: TEMPLATE_SLUG,
  });
  if (!ok) {
    throw new Error(
      `setup-preview failed (HTTP ${status}): ${JSON.stringify(data).slice(0, 2000)}`,
    );
  }
  return data;
}

/** Soft checks mirroring what the wizard surfaces; returns warning strings. */
function validateAgainstPreview(preview, presetName, selectedProviderNames) {
  const warnings = [];
  const installed = new Set(
    (preview.localAvailability?.installedProviders ?? []).map((p) =>
      String(p.name).trim().toLowerCase(),
    ),
  );
  for (const name of selectedProviderNames) {
    if (!installed.has(name.trim().toLowerCase())) {
      warnings.push(`provider "${name}" is not installed locally`);
    }
  }
  if (presetName) {
    const presets = preview.payload?.presets ?? [];
    if (!presets.some((p) => p.name === presetName)) {
      warnings.push(`preset "${presetName}" not found in template "${TEMPLATE_SLUG}"`);
    } else {
      const coverage = (preview.presetProviderCoverage ?? []).find(
        (c) => c.presetName === presetName,
      );
      const missing = (coverage?.referencedProviders ?? []).filter(
        (p) => !selectedProviderNames.some((s) => eqName(s, p)),
      );
      if (missing.length > 0) {
        warnings.push(
          `preset "${presetName}" references providers not in the selection: ${missing.join(', ')}`,
        );
      }
    }
  }
  return warnings;
}

function buildPayload({ name, rootPath, presetName, preview }) {
  const payload = {
    name,
    rootPath,
    slug: TEMPLATE_SLUG,
    version: null,
    selectedProviderNames: [...SELECTED_PROVIDERS],
  };
  if (presetName) payload.presetName = presetName;

  if (preview) {
    const familyProviderMappings = deriveFamilyProviderMappings(
      preview.familyAlternatives,
      SELECTED_PROVIDERS,
    );
    if (Object.keys(familyProviderMappings).length > 0) {
      payload.familyProviderMappings = familyProviderMappings;
    }
    const teamOverrides = buildTeamOverrides(
      preview.payload?.teams,
      preview.payload?.profiles,
      SELECTED_PROVIDERS,
    );
    if (teamOverrides.length > 0) payload.teamOverrides = teamOverrides;
  }
  return payload;
}

function printPayload(payload) {
  console.log('Payload that would be POSTed:');
  console.log(JSON.stringify(payload, null, 2));
}

function printResult({ ok, status, data }) {
  if (ok && data?.success === true && data.project) {
    console.log(`Created project "${data.project.name}" (id: ${data.project.id})`);
    if (Array.isArray(data.warnings) && data.warnings.length > 0) {
      console.log('Warnings:');
      for (const w of data.warnings) console.log(`  - ${JSON.stringify(w)}`);
    }
    if (Array.isArray(data.provisioningWarnings) && data.provisioningWarnings.length > 0) {
      console.log('Provisioning warnings:');
      for (const w of data.provisioningWarnings) console.log(`  - ${JSON.stringify(w)}`);
    }
    return;
  }
  if (data?.providerMappingRequired) {
    console.error('Provider mapping required — the API could not auto-select providers:');
    console.error(JSON.stringify(data.providerMappingRequired, null, 2));
    return;
  }
  console.error(`Request failed (HTTP ${status}):`);
  console.error(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPath = toServerPath(args.path.trim());
  const name = projectNameFromPath(args.path.trim());
  const presetName =
    args.preset === 'none' || args.preset === 'null' || args.preset === '-' ? null : args.preset;
  const baseUrl = `http://127.0.0.1:${args.port}`;

  if (rootPath !== args.path.trim()) {
    console.log(`Path: ${args.path.trim()} -> ${rootPath}`);
  }

  let preview = null;
  try {
    preview = await fetchSetupPreview(baseUrl);
  } catch (error) {
    console.warn(`Warning: setup-preview unavailable (${error.message}); derived fields omitted.`);
  }

  if (preview) {
    for (const warning of validateAgainstPreview(preview, presetName, SELECTED_PROVIDERS)) {
      console.warn(`Warning: ${warning}`);
    }
  }

  const payload = buildPayload({ name, rootPath, presetName, preview });

  if (args.dryRun) {
    printPayload(payload);
    return;
  }

  let result = await postJson(baseUrl, '/api/projects/from-template', payload);

  // Mirror the wizard's provider-mapping modal: when the API demands explicit
  // family→provider mappings, derive them from the returned alternatives and
  // retry once.
  if (
    result.data?.providerMappingRequired &&
    !payload.familyProviderMappings &&
    result.data.providerMappingRequired.canImport !== false
  ) {
    const alternatives = result.data.providerMappingRequired.familyAlternatives ?? [];
    const mappings = deriveFamilyProviderMappings(alternatives, SELECTED_PROVIDERS);
    // Retry only when every family that lost its default provider got a mapping.
    const allResolved = alternatives
      .filter((family) => family.defaultProviderAvailable !== true)
      .every((family) =>
        Object.prototype.hasOwnProperty.call(
          mappings,
          String(family.familySlug ?? '').trim().toLowerCase(),
        ),
      );
    if (allResolved && Object.keys(mappings).length > 0) {
      console.log(`Auto-derived familyProviderMappings: ${JSON.stringify(mappings)}`);
      result = await postJson(baseUrl, '/api/projects/from-template', {
        ...payload,
        familyProviderMappings: mappings,
      });
    }
  }

  printResult(result);
  if (!(result.ok && result.data?.success === true)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
