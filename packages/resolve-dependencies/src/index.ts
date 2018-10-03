import { DirectoryResolution, LocalPackages, Resolution } from '@pnpm/resolver-base'
import { PackageJson, ReadPackageHook } from '@pnpm/types'
import { createNodeId, nodeIdContainsSequence, ROOT_NODE_ID, WantedDependency } from '@pnpm/utils'
import { StoreController } from 'package-store'
import { Shrinkwrap } from 'pnpm-shrinkwrap'
import getPreferredVersionsFromPackage from './getPreferredVersions'
import resolveDependencies, { PkgAddress, ResolutionContext } from './resolveDependencies'

export { ResolvedPackage, DependenciesTree, DependenciesTreeNode } from './resolveDependencies'
export { InstallCheckLog, DeprecationLog } from './loggers'

export default async function (
  opts: {
    currentShrinkwrap: Shrinkwrap,
    depth: number,
    dryRun: boolean,
    engineStrict: boolean,
    force: boolean,
    importers: Array<{
      packageJson: PackageJson,
      prefix: string,
      relativePath: string,
      shamefullyFlatten: boolean,
    }>,
    hooks: {
      readPackage?: ReadPackageHook,
    },
    nodeVersion: string,
    nonLinkedPackages: WantedDependency[],
    rawNpmConfig: object,
    pkg?: PackageJson,
    pnpmVersion: string,
    sideEffectsCache: boolean,
    preferredVersions?: {
      [packageName: string]: {
        selector: string,
        type: 'version' | 'range' | 'tag',
      },
    },
    prefix: string,
    skipped: Set<string>,
    storeController: StoreController,
    tag: string,
    verifyStoreIntegrity: boolean,
    virtualStoreDir: string,
    wantedShrinkwrap: Shrinkwrap,
    update: boolean,
    hasManifestInShrinkwrap: boolean,
    localPackages: LocalPackages,
  },
) {
  const preferredVersions = opts.preferredVersions || opts.pkg && getPreferredVersionsFromPackage(opts.pkg) || {}
  const rootPkgsByImporterPath = {} as {[importerPath: string]: PkgAddress[]}
  const resolvedFromLocalPackagesByImporterPath = {}

  const ctx: ResolutionContext = {
    childrenByParentId: {},
    currentShrinkwrap: opts.currentShrinkwrap,
    defaultTag: opts.tag,
    dependenciesTree: {},
    depth: opts.depth,
    dryRun: opts.dryRun,
    engineStrict: opts.engineStrict,
    force: opts.force,
    nodeVersion: opts.nodeVersion,
    outdatedDependencies: {},
    pendingNodes: [],
    pnpmVersion: opts.pnpmVersion,
    preferredVersions,
    prefix: opts.prefix,
    rawNpmConfig: opts.rawNpmConfig,
    registry: opts.wantedShrinkwrap.registry,
    resolvedFromLocalPackages: [],
    resolvedPackagesByPackageId: {},
    skipped: opts.skipped,
    storeController: opts.storeController,
    verifyStoreIntegrity: opts.verifyStoreIntegrity,
    virtualStoreDir: opts.virtualStoreDir,
    wantedShrinkwrap: opts.wantedShrinkwrap,
  }

  // TODO: try to make it concurrent
  for (const importer of opts.importers) {
    const shrImporter = opts.wantedShrinkwrap.importers[importer.relativePath]
    ctx.resolvedFromLocalPackages = []
    rootPkgsByImporterPath[importer.relativePath] = await resolveDependencies(
      ctx,
      opts.nonLinkedPackages,
      {
        currentDepth: 0,
        hasManifestInShrinkwrap: opts.hasManifestInShrinkwrap,
        keypath: [],
        localPackages: opts.localPackages,
        parentNodeId: ROOT_NODE_ID,
        readPackageHook: opts.hooks.readPackage,
        resolvedDependencies: {
          ...shrImporter.dependencies,
          ...shrImporter.devDependencies,
          ...shrImporter.optionalDependencies,
        },
        shamefullyFlatten: importer.shamefullyFlatten,
        sideEffectsCache: opts.sideEffectsCache,
        update: opts.update,
      },
    )
    resolvedFromLocalPackagesByImporterPath[importer.relativePath] = ctx.resolvedFromLocalPackages
  }

  ctx.pendingNodes.forEach((pendingNode) => {
    ctx.dependenciesTree[pendingNode.nodeId] = {
      children: () => buildTree(ctx, pendingNode.nodeId, pendingNode.resolvedPackage.id,
        ctx.childrenByParentId[pendingNode.resolvedPackage.id], pendingNode.depth + 1, pendingNode.installable),
      depth: pendingNode.depth,
      installable: pendingNode.installable,
      resolvedPackage: pendingNode.resolvedPackage,
    }
  })

  const resolvedImporters = {} as {
    [importerPath: string]: {
      directDependencies: Array<{
        alias: string,
        optional: boolean,
        dev: boolean,
        resolution: Resolution,
        id: string,
        version: string,
        name: string,
        specRaw: string,
        normalizedPref?: string,
      }>,
      directNodeIdsByAlias: {
        [alias: string]: string,
      },
      resolvedFromLocalPackages: Array<{
        optional: boolean,
        dev: boolean,
        resolution: DirectoryResolution,
        id: string,
        version: string,
        name: string,
        specRaw: string,
        normalizedPref?: string,
        alias: string,
      }>,
    },
  }

  for (const importer of opts.importers) {
    const rootPkgs = rootPkgsByImporterPath[importer.relativePath]
    const resolvedFromLocalPackages = resolvedFromLocalPackagesByImporterPath[importer.relativePath]

    resolvedImporters[importer.relativePath] = {
      directDependencies: [
        ...rootPkgs
          .map((rootPkg) => ({
            ...ctx.dependenciesTree[rootPkg.nodeId].resolvedPackage,
            alias: rootPkg.alias,
            normalizedPref: rootPkg.normalizedPref,
          })) as Array<{
            alias: string,
            optional: boolean,
            dev: boolean,
            resolution: Resolution,
            id: string,
            version: string,
            name: string,
            specRaw: string,
            normalizedPref?: string,
          }>,
        ...resolvedFromLocalPackages,
      ],
      directNodeIdsByAlias: rootPkgs
        .reduce((acc, rootPkg) => {
          acc[rootPkg.alias] = rootPkg.nodeId
          return acc
        }, {}),
      resolvedFromLocalPackages,
    }
  }

  return {
    dependenciesTree: ctx.dependenciesTree,
    outdatedDependencies: ctx.outdatedDependencies,
    resolvedImporters,
    resolvedPackagesByPackageId: ctx.resolvedPackagesByPackageId,
  }
}

function buildTree (
  ctx: ResolutionContext,
  parentNodeId: string,
  parentId: string,
  children: Array<{alias: string, pkgId: string}>,
  depth: number,
  installable: boolean,
) {
  const childrenNodeIds = {}
  for (const child of children) {
    if (nodeIdContainsSequence(parentNodeId, parentId, child.pkgId)) {
      continue
    }
    const childNodeId = createNodeId(parentNodeId, child.pkgId)
    childrenNodeIds[child.alias] = childNodeId
    installable = installable && !ctx.skipped.has(child.pkgId)
    ctx.dependenciesTree[childNodeId] = {
      children: () => buildTree(ctx, childNodeId, child.pkgId, ctx.childrenByParentId[child.pkgId], depth + 1, installable),
      depth,
      installable,
      resolvedPackage: ctx.resolvedPackagesByPackageId[child.pkgId],
    }
  }
  return childrenNodeIds
}
