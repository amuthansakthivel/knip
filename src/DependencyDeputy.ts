import { isBuiltin } from 'node:module';
import { Workspace } from './ConfigurationChief.js';
import {
  IGNORE_DEFINITELY_TYPED,
  IGNORED_DEPENDENCIES,
  IGNORED_GLOBAL_BINARIES,
  ROOT_WORKSPACE_NAME,
} from './constants.js';
import { isDefinitelyTyped, getDefinitelyTypedFor, getPackageFromDefinitelyTyped } from './util/modules.js';
import type { ConfigurationHints, Issue } from './types/issues.js';
import type { WorkspaceManifests } from './types/workspace.js';
import type { PeerDependencies, InstalledBinaries } from './types/workspace.js';
import type { PackageJson } from '@npmcli/package-json';

type Options = {
  isStrict: boolean;
};

/**
 * - Stores manifests
 * - Stores referenced external dependencies
 * - Stores binaries and peer dependencies
 * - Settles dependency issues
 */
export class DependencyDeputy {
  isStrict;
  _manifests: WorkspaceManifests = new Map();
  referencedDependencies: Map<string, Set<string>>;
  referencedBinaries: Map<string, Set<string>>;
  peerDependencies: Map<string, PeerDependencies>;
  installedBinaries: Map<string, InstalledBinaries>;
  ignoreBinaries: string[] = [];
  ignoreDependencies: string[] = [];

  constructor({ isStrict }: Options) {
    this.isStrict = isStrict;
    this.referencedDependencies = new Map();
    this.referencedBinaries = new Map();
    this.peerDependencies = new Map();
    this.installedBinaries = new Map();
  }

  public addWorkspace({
    name,
    dir,
    manifestPath,
    manifest,
    ignoreDependencies,
    ignoreBinaries,
  }: {
    name: string;
    dir: string;
    manifestPath: string;
    manifest: PackageJson;
    ignoreDependencies: string[];
    ignoreBinaries: string[];
  }) {
    const scripts = Object.values(manifest.scripts ?? {}) as string[];
    const dependencies = Object.keys(manifest.dependencies ?? {});
    const peerDependencies = Object.keys(manifest.peerDependencies ?? {});
    const optionalDependencies = Object.keys(manifest.optionalDependencies ?? {});
    const devDependencies = Object.keys(manifest.devDependencies ?? {});
    const allDependencies = [...dependencies, ...devDependencies, ...peerDependencies, ...optionalDependencies];

    this._manifests.set(name, {
      workspaceDir: dir,
      manifestPath,
      ignoreDependencies,
      ignoreBinaries,
      scripts,
      dependencies,
      peerDependencies,
      optionalDependencies,
      devDependencies,
      allDependencies,
    });
  }

  addIgnored(ignoreBinaries: string[], ignoreDependencies: string[]) {
    this.ignoreBinaries = ignoreBinaries;
    this.ignoreDependencies = ignoreDependencies;
  }

  getWorkspaceManifest(workspaceName: string) {
    return this._manifests.get(workspaceName);
  }

  getProductionDependencies(workspaceName: string) {
    const manifest = this._manifests.get(workspaceName);
    if (!manifest) return [];
    if (this.isStrict) return [...manifest.dependencies, ...manifest.peerDependencies];
    return manifest.dependencies;
  }

  getDevDependencies(workspaceName: string) {
    return this._manifests.get(workspaceName)?.devDependencies ?? [];
  }

  setInstalledBinaries(workspaceName: string, installedBinaries: Map<string, Set<string>>) {
    this.installedBinaries.set(workspaceName, installedBinaries);
  }

  getInstalledBinaries(workspaceName: string) {
    return this.installedBinaries.get(workspaceName);
  }

  addReferencedDependency(workspaceName: string, packageName: string) {
    if (!this.referencedDependencies.has(workspaceName)) {
      this.referencedDependencies.set(workspaceName, new Set());
    }
    this.referencedDependencies.get(workspaceName)?.add(packageName);
  }

  addReferencedBinary(workspaceName: string, binaryName: string) {
    if (!this.referencedBinaries.has(workspaceName)) {
      this.referencedBinaries.set(workspaceName, new Set());
    }
    this.referencedBinaries.get(workspaceName)?.add(binaryName);
  }

  addPeerDependencies(workspaceName: string, peerDependencies: Map<string, Set<string>>) {
    this.peerDependencies.set(workspaceName, peerDependencies);
  }

  getPeerDependencies(workspaceName: string, dependency: string) {
    return Array.from(this.peerDependencies.get(workspaceName)?.get(dependency) ?? []);
  }

  /**
   * Returns `true` to indicate the external dependency has been handled properly. When `false`, the call-site probably
   * wants to mark the dependency as "unlisted".
   */
  public maybeAddReferencedExternalDependency(workspace: Workspace, packageName: string): boolean {
    if (isBuiltin(packageName)) return true;

    // Ignore self-referenced imports
    if (packageName === workspace.pkgName) return true;

    const workspaceNames = this.isStrict ? [workspace.name] : [workspace.name, ...[...workspace.ancestors].reverse()];
    const closestWorkspaceName = workspaceNames.find(name => this.isInDependencies(name, packageName));

    // Prevent false positives by also marking the `@types/packageName` dependency as referenced
    const typesPackageName = !isDefinitelyTyped(packageName) && getDefinitelyTypedFor(packageName);
    const closestWorkspaceNameForTypes =
      typesPackageName && workspaceNames.find(name => this.isInDependencies(name, typesPackageName));

    if (closestWorkspaceName || closestWorkspaceNameForTypes) {
      closestWorkspaceName && this.addReferencedDependency(closestWorkspaceName, packageName);
      closestWorkspaceNameForTypes && this.addReferencedDependency(closestWorkspaceNameForTypes, typesPackageName);
      return true;
    } else {
      this.addReferencedDependency(workspace.name, packageName);
    }

    if (this.getWorkspaceManifest(workspace.name)?.ignoreDependencies.includes(packageName)) return true;
    if (this.ignoreDependencies.includes(packageName)) return true;

    return false;
  }

  public maybeAddReferencedBinary(workspace: Workspace, binaryName: string): boolean {
    if (IGNORED_GLOBAL_BINARIES.includes(binaryName)) return true;

    this.addReferencedBinary(workspace.name, binaryName);

    const workspaceNames = this.isStrict ? [workspace.name] : [workspace.name, ...[...workspace.ancestors].reverse()];

    for (const name of workspaceNames) {
      const binaries = this.getInstalledBinaries(name);
      if (binaries?.has(binaryName)) {
        const dependencies = binaries.get(binaryName);
        if (dependencies?.size) {
          dependencies.forEach(dependency => this.addReferencedDependency(name, dependency));
          return true;
        }
      }
    }

    if (this.getWorkspaceManifest(workspace.name)?.ignoreBinaries.includes(binaryName)) return true;
    if (this.ignoreBinaries.includes(binaryName)) return true;

    return false;
  }

  private isInDependencies(workspaceName: string, packageName: string) {
    const manifest = this._manifests.get(workspaceName);
    if (!manifest) return false;
    const dependencies = this.isStrict ? this.getProductionDependencies(workspaceName) : manifest.allDependencies;
    return dependencies.includes(packageName);
  }

  public settleDependencyIssues() {
    const dependencyIssues: Issue[] = [];
    const devDependencyIssues: Issue[] = [];

    for (const [workspaceName, { manifestPath, ignoreDependencies, ignoreBinaries }] of this._manifests.entries()) {
      const referencedDependencies = this.referencedDependencies.get(workspaceName);
      const installedBinaries = this.getInstalledBinaries(workspaceName);
      const ignoreBins = [...IGNORED_GLOBAL_BINARIES, ...this.ignoreBinaries, ...ignoreBinaries];
      const ignoreDeps = [...IGNORED_DEPENDENCIES, ...this.ignoreDependencies, ...ignoreDependencies];

      const isNotIgnoredDependency = (packageName: string) => !ignoreDeps.includes(packageName);

      const isNotIgnoredBinary = (packageName: string) => {
        if (installedBinaries?.has(packageName)) {
          const binaryNames = installedBinaries.get(packageName);
          if (binaryNames) {
            if (ignoreBins.some(ignoredBinary => binaryNames.has(ignoredBinary))) return false;
          }
        }
        return true;
      };

      // Keeping track of peer dependency recursions to prevent infinite loops for circularly referenced peer deps
      const peerDepRecs: Record<string, number> = {};

      const isNotReferencedDependency = (dependency: string, isPeerDep?: boolean): boolean => {
        // Is referenced, ignore
        if (referencedDependencies?.has(dependency)) return false;

        // Returning peer dependency, ignore
        if (isPeerDep && peerDepRecs[dependency]) return true;

        const [scope, typedDependency] = dependency.split('/');
        if (scope === '@types') {
          const typedPackageName = getPackageFromDefinitelyTyped(typedDependency);
          // Ignore `@types/*` packages that don't have a related dependency (e.g. `@types/node`)
          if (IGNORE_DEFINITELY_TYPED.includes(typedPackageName)) return false;

          // Ignore typed dependencies that have a peer dependency that's referenced
          // Example: `next` has `react-dom` as peer dependency, so when `@types/react-dom` is listed it can be ignored
          const peerDependencies = this.getPeerDependencies(workspaceName, typedPackageName);
          if (peerDependencies.length) {
            return !peerDependencies.find(peerDependency => !isNotReferencedDependency(peerDependency, true));
          }

          return !referencedDependencies?.has(typedPackageName);
        }

        // A dependency may not be referenced, but it may be a peerDependency of another.
        // If that peerDependency is also not referenced we'll report it as unused.
        const peerDependencies = this.getPeerDependencies(workspaceName, dependency);
        peerDependencies.forEach(dep => (!peerDepRecs[dep] ? (peerDepRecs[dep] = 1) : peerDepRecs[dep]++));
        return !peerDependencies.find(peerDependency => !isNotReferencedDependency(peerDependency, true));
      };

      const pd = this.getProductionDependencies(workspaceName);
      const dd = this.getDevDependencies(workspaceName);

      pd.filter(isNotIgnoredDependency)
        .filter(isNotIgnoredBinary)
        .filter(d => isNotReferencedDependency(d))
        .forEach(symbol => dependencyIssues.push({ type: 'dependencies', filePath: manifestPath, symbol }));

      dd.filter(isNotIgnoredDependency)
        .filter(isNotIgnoredBinary)
        .filter(d => isNotReferencedDependency(d))
        .forEach(symbol => devDependencyIssues.push({ type: 'devDependencies', filePath: manifestPath, symbol }));
    }

    return { dependencyIssues, devDependencyIssues };
  }

  public getConfigurationHints() {
    const configurationHints: ConfigurationHints = new Set();

    const rootIgnoreBinaries = Object.fromEntries(this.ignoreBinaries.map(key => [key, 0]));
    const rootIgnoreDependencies = Object.fromEntries(this.ignoreDependencies.map(key => [key, 0]));

    for (const [workspaceName, { ignoreDependencies, ignoreBinaries }] of this._manifests.entries()) {
      const referencedDependencies = this.referencedDependencies.get(workspaceName);
      const referencedBinaries = this.referencedBinaries.get(workspaceName);
      const installedBinaries = this.getInstalledBinaries(workspaceName);

      referencedDependencies?.forEach(pkg => pkg in rootIgnoreDependencies && rootIgnoreDependencies[pkg]++);
      referencedBinaries?.forEach(binaryName => binaryName in rootIgnoreBinaries && rootIgnoreBinaries[binaryName]++);

      const dependencies = this.isStrict
        ? this.getProductionDependencies(workspaceName)
        : [...this.getProductionDependencies(workspaceName), ...this.getDevDependencies(workspaceName)];

      const isReferencedDep = (name: string) => referencedDependencies?.has(name) && dependencies.includes(name);
      const isReferencedBin = (name: string) => referencedBinaries?.has(name) && installedBinaries?.has(name);

      // Add configuration hint for dependencies/binaries in global/top-level ignores or when referenced + listed
      ignoreDependencies
        .filter(
          packageName =>
            IGNORED_DEPENDENCIES.includes(packageName) ||
            (workspaceName !== ROOT_WORKSPACE_NAME && this.ignoreDependencies.includes(packageName)) ||
            isReferencedDep(packageName)
        )
        .forEach(identifier => configurationHints.add({ workspaceName, identifier, type: 'ignoreDependencies' }));

      ignoreBinaries
        .filter(
          binaryName =>
            IGNORED_GLOBAL_BINARIES.includes(binaryName) ||
            (workspaceName !== ROOT_WORKSPACE_NAME && this.ignoreBinaries.includes(binaryName)) ||
            isReferencedBin(binaryName)
        )
        .forEach(identifier => configurationHints.add({ workspaceName, identifier, type: 'ignoreBinaries' }));
    }

    const installedBinaries = this.getInstalledBinaries(ROOT_WORKSPACE_NAME);
    const dependencies = this.isStrict
      ? this.getProductionDependencies(ROOT_WORKSPACE_NAME)
      : [...this.getProductionDependencies(ROOT_WORKSPACE_NAME), ...this.getDevDependencies(ROOT_WORKSPACE_NAME)];

    // Add configuration hint for dependencies/binaries in global ignores or when referenced + listed
    Object.keys(rootIgnoreBinaries)
      .filter(
        key => IGNORED_GLOBAL_BINARIES.includes(key) || (rootIgnoreBinaries[key] !== 0 && installedBinaries?.has(key))
      )
      .forEach(identifier =>
        configurationHints.add({ workspaceName: ROOT_WORKSPACE_NAME, identifier, type: 'ignoreBinaries' })
      );

    Object.keys(rootIgnoreDependencies)
      .filter(
        key => IGNORED_DEPENDENCIES.includes(key) || (rootIgnoreDependencies[key] !== 0 && dependencies.includes(key))
      )
      .forEach(identifier =>
        configurationHints.add({ workspaceName: ROOT_WORKSPACE_NAME, identifier, type: 'ignoreDependencies' })
      );

    return { configurationHints };
  }
}
