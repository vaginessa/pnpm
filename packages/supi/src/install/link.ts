import {
  rootLogger,
  stageLogger,
  statsLogger,
} from '@pnpm/core-loggers'
import linkBins, { linkBinsOfPackages } from '@pnpm/link-bins'
import logger from '@pnpm/logger'
import { prune } from '@pnpm/modules-cleaner'
import { IncludedDependencies } from '@pnpm/modules-yaml'
import { fromDir as readPackageFromDir } from '@pnpm/read-package-json'
import { DependenciesTree } from '@pnpm/resolve-dependencies'
import { PackageJson } from '@pnpm/types'
import * as dp from 'dependency-path'
import pLimit = require('p-limit')
import { StoreController } from 'package-store'
import path = require('path')
import { PackageSnapshot, Shrinkwrap } from 'pnpm-shrinkwrap'
import R = require('ramda')
import { SHRINKWRAP_MINOR_VERSION } from '../constants'
import shamefullyFlattenGraph from '../shamefullyFlattenGraph'
import symlinkDependencyTo from '../symlinkDependencyTo'
import resolvePeers, {
  DependenciesGraph,
  DependenciesGraphNode,
} from './resolvePeers'
import updateShrinkwrap from './updateShrinkwrap'

export { DependenciesGraph }

export default async function linkPackages (
  rootNodeIdsByAlias: {[alias: string]: string},
  dependenciesTree: DependenciesTree,
  opts: {
    afterAllResolvedHook?: (shr: Shrinkwrap) => Shrinkwrap,
    force: boolean,
    dryRun: boolean,
    importerModulesDir: string,
    virtualStoreDir: string,
    bin: string,
    topParents: Array<{name: string, version: string}>,
    wantedShrinkwrap: Shrinkwrap,
    currentShrinkwrap: Shrinkwrap,
    makePartialCurrentShrinkwrap: boolean,
    prefix: string,
    pruneStore: boolean,
    storeController: StoreController,
    skipped: Set<string>,
    pkg: PackageJson,
    include: IncludedDependencies,
    independentLeaves: boolean,
    // This is only needed till shrinkwrap v4
    updateShrinkwrapMinorVersion: boolean,
    outdatedDependencies: {[pkgId: string]: string},
    sideEffectsCache: boolean,
    shamefullyFlatten: boolean,
    hoistedAliases: {[depPath: string]: string[]},
    strictPeerDependencies: boolean,
    importerPath: string,
    externalShrinkwrap: boolean,
  },
): Promise<{
  currentShrinkwrap: Shrinkwrap,
  depGraph: DependenciesGraph,
  hoistedAliases: {[depPath: string]: string[]},
  newDepPaths: string[],
  removedDepPaths: Set<string>,
  wantedShrinkwrap: Shrinkwrap,
}> {
  // TODO: decide what kind of logging should be here.
  // The `Creating dependency graph` is not good to report in all cases as
  // sometimes node_modules is alread up-to-date
  // logger.info(`Creating dependency graph`)
  const resolvePeersResult = await resolvePeers({
    dependenciesTree,
    externalShrinkwrap: opts.externalShrinkwrap,
    independentLeaves: opts.independentLeaves,
    prefix: opts.prefix,
    rootNodeIdsByAlias,
    strictPeerDependencies: opts.strictPeerDependencies,
    topParents: opts.topParents,
    virtualStoreDir: opts.virtualStoreDir,
  })
  const depGraph = resolvePeersResult.depGraph
  if (opts.externalShrinkwrap) {
    for (const alias of R.keys(resolvePeersResult.rootAbsolutePathsByAlias)) {
      const depPath = resolvePeersResult.rootAbsolutePathsByAlias[alias]

      if (depGraph[depPath].isPure) continue

      const importer = opts.wantedShrinkwrap.importers[opts.importerPath]
      const ref = dp.relative(opts.wantedShrinkwrap.registry, depPath)
      if (importer.dependencies && importer.dependencies[alias]) {
        importer.dependencies[alias] = ref
      } else if (importer.devDependencies && importer.devDependencies[alias]) {
        importer.devDependencies[alias] = ref
      } else if (importer.optionalDependencies && importer.optionalDependencies[alias]) {
        importer.optionalDependencies[alias] = ref
      }
    }
  }
  let {newShrinkwrap, pendingRequiresBuilds} = updateShrinkwrap(depGraph, opts.wantedShrinkwrap, opts.prefix) // tslint:disable-line:prefer-const
  if (opts.afterAllResolvedHook) {
    newShrinkwrap = opts.afterAllResolvedHook(newShrinkwrap)
  }

  let depNodes = R.values(depGraph).filter((depNode) => {
    const relDepPath = dp.relative(newShrinkwrap.registry, depNode.absolutePath)
    if (newShrinkwrap.packages && newShrinkwrap.packages[relDepPath] && !newShrinkwrap.packages[relDepPath].optional) {
      opts.skipped.delete(depNode.id)
      return true
    }
    return !opts.skipped.has(depNode.id)
  })
  if (!opts.include.dependencies) {
    depNodes = depNodes.filter((depNode) => depNode.dev !== false || depNode.optional)
  }
  if (!opts.include.devDependencies) {
    depNodes = depNodes.filter((depNode) => depNode.dev !== true)
  }
  if (!opts.include.optionalDependencies) {
    depNodes = depNodes.filter((depNode) => !depNode.optional)
  }
  const filterOpts = {
    importerPath: opts.importerPath,
    include: opts.include,
    skipped: opts.skipped,
  }
  const newCurrentShrinkwrap = filterShrinkwrap(newShrinkwrap, filterOpts)
  const removedDepPaths = await prune({
    bin: opts.bin,
    dryRun: opts.dryRun,
    hoistedAliases: opts.hoistedAliases,
    importerModulesDir: opts.importerModulesDir,
    importerPath: opts.importerPath,
    newShrinkwrap: newCurrentShrinkwrap,
    oldShrinkwrap: opts.currentShrinkwrap,
    prefix: opts.prefix,
    pruneStore: opts.pruneStore,
    shamefullyFlatten: opts.shamefullyFlatten,
    storeController: opts.storeController,
    virtualStoreDir: opts.virtualStoreDir,
  })

  stageLogger.debug('importing_started')
  const newDepPaths = await linkNewPackages(
    filterShrinkwrap(opts.currentShrinkwrap, filterOpts),
    newCurrentShrinkwrap,
    depGraph,
    {
      dryRun: opts.dryRun,
      force: opts.force,
      importerModulesDir: opts.importerModulesDir,
      optional: opts.include.optionalDependencies,
      prefix: opts.prefix,
      sideEffectsCache: opts.sideEffectsCache,
      storeController: opts.storeController,
    },
  )
  stageLogger.debug('importing_done')

  const rootDepsByDepPath = depNodes
    .filter((depNode) => depNode.depth === 0)
    .reduce((acc, depNode) => {
      acc[depNode.absolutePath] = depNode
      return acc
    }, {}) as {[absolutePath: string]: DependenciesGraphNode}
  for (const rootAlias of R.keys(resolvePeersResult.rootAbsolutePathsByAlias)) {
    const pkg = rootDepsByDepPath[resolvePeersResult.rootAbsolutePathsByAlias[rootAlias]]
    if (!pkg) continue
    if (opts.dryRun || !(await symlinkDependencyTo(rootAlias, pkg.peripheralLocation, opts.importerModulesDir)).reused) {
      const isDev = opts.pkg.devDependencies && opts.pkg.devDependencies[pkg.name]
      const isOptional = opts.pkg.optionalDependencies && opts.pkg.optionalDependencies[pkg.name]
      rootLogger.debug({
        added: {
          dependencyType: isDev && 'dev' || isOptional && 'optional' || 'prod',
          id: pkg.id,
          latest: opts.outdatedDependencies[pkg.id],
          name: rootAlias,
          realName: pkg.name,
          version: pkg.version,
        },
        prefix: opts.prefix,
      })
    }
  }

  if (opts.updateShrinkwrapMinorVersion) {
    // Setting `shrinkwrapMinorVersion` is a temporary solution to
    // have new backward-compatible versions of `shrinkwrap.yaml`
    // w/o changing `shrinkwrapVersion`. From version 4, the
    // `shrinkwrapVersion` field allows numbers like 4.1
    newShrinkwrap.shrinkwrapMinorVersion = SHRINKWRAP_MINOR_VERSION
  }

  await Promise.all(pendingRequiresBuilds.map(async (pendingRequiresBuild) => {
    const depNode = depGraph[pendingRequiresBuild.absoluteDepPath]
    if (!depNode.fetchingRawManifest) {
      // This should never ever happen
      throw new Error(`Cannot create shrinkwrap.yaml because raw manifest (aka package.json) wasn't fetched for "${pendingRequiresBuild.absoluteDepPath}"`)
    }
    const filesResponse = await depNode.fetchingFiles
    // The npm team suggests to always read the package.json for deciding whether the package has lifecycle scripts
    const pkgJson = await depNode.fetchingRawManifest
    depNode.requiresBuild = Boolean(
      pkgJson.scripts && (pkgJson.scripts.preinstall || pkgJson.scripts.install || pkgJson.scripts.postinstall) ||
      filesResponse.filenames.indexOf('binding.gyp') !== -1 ||
        filesResponse.filenames.some((filename) => !!filename.match(/^[.]hooks[\\/]/)), // TODO: optimize this
    )

    if (depNode.requiresBuild) {
      newShrinkwrap!.packages![pendingRequiresBuild.relativeDepPath].requiresBuild = true
    }
  }))

  let currentShrinkwrap: Shrinkwrap
  if (opts.makePartialCurrentShrinkwrap) {
    const packages = opts.currentShrinkwrap.packages || {}
    if (newShrinkwrap.packages) {
      for (const relDepPath in newShrinkwrap.packages) { // tslint:disable-line:forin
        const depPath = dp.resolve(newShrinkwrap.registry, relDepPath)
        if (depGraph[depPath]) {
          packages[relDepPath] = newShrinkwrap.packages[relDepPath]
        }
      }
    }
    currentShrinkwrap = {...newShrinkwrap, packages}
  } else if (opts.include.dependencies && opts.include.devDependencies && opts.include.optionalDependencies && opts.skipped.size === 0) {
    currentShrinkwrap = newShrinkwrap
  } else {
    currentShrinkwrap = newCurrentShrinkwrap
  }

  // Important: shamefullyFlattenGraph changes depGraph, so keep this at the end, right before linkBins
  if (opts.shamefullyFlatten && (newDepPaths.length > 0 || removedDepPaths.size > 0)) {
    opts.hoistedAliases = await shamefullyFlattenGraph(depNodes, currentShrinkwrap.importers[opts.importerPath].specifiers, opts)
  }

  if (!opts.dryRun) {
    await linkBins(opts.importerModulesDir, opts.bin, {
      warn: (message: string) => logger.warn({message, prefix: opts.prefix}),
    })
  }

  return {
    currentShrinkwrap,
    depGraph,
    hoistedAliases: opts.hoistedAliases,
    newDepPaths,
    removedDepPaths,
    wantedShrinkwrap: newShrinkwrap,
  }
}

function filterShrinkwrap (
  shr: Shrinkwrap,
  opts: {
    include: IncludedDependencies,
    skipped: Set<string>,
    importerPath: string,
  },
): Shrinkwrap {
  let pairs = (R.toPairs(shr.packages || {}) as Array<[string, PackageSnapshot]>)
    .filter((pair) => !opts.skipped.has(pair[1].id || dp.resolve(shr.registry, pair[0])))
  if (!opts.include.dependencies) {
    pairs = pairs.filter((pair) => pair[1].dev !== false || pair[1].optional)
  }
  if (!opts.include.devDependencies) {
    pairs = pairs.filter((pair) => pair[1].dev !== true)
  }
  if (!opts.include.optionalDependencies) {
    pairs = pairs.filter((pair) => !pair[1].optional)
  }
  const shrImporter = shr.importers[opts.importerPath]
  return {
    importers: {
      ...shr.importers,
      [opts.importerPath]: {
        dependencies: !opts.include.dependencies ? {} : shrImporter.dependencies || {},
        devDependencies: !opts.include.devDependencies ? {} : shrImporter.devDependencies || {},
        optionalDependencies: !opts.include.optionalDependencies ? {} : shrImporter.optionalDependencies || {},
        specifiers: shrImporter.specifiers,
      },
    },
    packages: R.fromPairs(pairs),
    registry: shr.registry,
    shrinkwrapVersion: shr.shrinkwrapVersion,
  } as Shrinkwrap
}

async function linkNewPackages (
  currentShrinkwrap: Shrinkwrap,
  wantedShrinkwrap: Shrinkwrap,
  depGraph: DependenciesGraph,
  opts: {
    importerModulesDir: string,
    dryRun: boolean,
    force: boolean,
    optional: boolean,
    sideEffectsCache: boolean,
    storeController: StoreController,
    prefix: string,
  },
): Promise<string[]> {
  const wantedRelDepPaths = R.keys(wantedShrinkwrap.packages)
  const prevRelDepPaths = R.keys(currentShrinkwrap.packages)

  // TODO: what if the registries differ?
  const newDepPathsSet = new Set(
    (
      opts.force
        ? wantedRelDepPaths
        : R.difference(wantedRelDepPaths, prevRelDepPaths)
    )
    .map((relDepPath) => dp.resolve(wantedShrinkwrap.registry, relDepPath))
    // when installing a new package, not all the nodes are analyzed
    // just skip the ones that are in the lockfile but were not analyzed
    .filter((depPath) => depGraph[depPath]),
  )
  statsLogger.debug({
    added: newDepPathsSet.size,
    prefix: opts.prefix,
  })

  const existingWithUpdatedDeps = []
  if (!opts.force && currentShrinkwrap.packages && wantedShrinkwrap.packages) {
    // add subdependencies that have been updated
    // TODO: no need to relink everything. Can be relinked only what was changed
    for (const relDepPath of wantedRelDepPaths) {
      if (currentShrinkwrap.packages[relDepPath] &&
        (!R.equals(currentShrinkwrap.packages[relDepPath].dependencies, wantedShrinkwrap.packages[relDepPath].dependencies) ||
        !R.equals(currentShrinkwrap.packages[relDepPath].optionalDependencies, wantedShrinkwrap.packages[relDepPath].optionalDependencies))) {
        const depPath = dp.resolve(wantedShrinkwrap.registry, relDepPath)

        // TODO: come up with a test that triggers the usecase of depGraph[depPath] undefined
        // see related issue: https://github.com/pnpm/pnpm/issues/870
        if (depGraph[depPath] && !newDepPathsSet.has(depPath)) {
          existingWithUpdatedDeps.push(depGraph[depPath])
        }
      }
    }
  }

  if (!newDepPathsSet.size && !existingWithUpdatedDeps.length) return []

  const newDepPaths = Array.from(newDepPathsSet)

  if (opts.dryRun) return newDepPaths

  const newPkgs = R.props<string, DependenciesGraphNode>(newDepPaths, depGraph)

  await Promise.all([
    linkAllModules(newPkgs, depGraph, {optional: opts.optional}),
    linkAllModules(existingWithUpdatedDeps, depGraph, {optional: opts.optional}),
    linkAllPkgs(opts.storeController, newPkgs, opts),
  ])

  await linkAllBins(newPkgs, depGraph, {
    optional: opts.optional,
    warn: (message: string) => logger.warn({message, prefix: opts.prefix}),
  })

  return newDepPaths
}

const limitLinking = pLimit(16)

async function linkAllPkgs (
  storeController: StoreController,
  depNodes: DependenciesGraphNode[],
  opts: {
    force: boolean,
    sideEffectsCache: boolean,
  },
) {
  return Promise.all(
    depNodes.map(async (depNode) => {
      const filesResponse = await depNode.fetchingFiles

      if (depNode.independent) return
      return storeController.importPackage(depNode.centralLocation, depNode.peripheralLocation, {
        filesResponse,
        force: opts.force,
      })
    }),
  )
}

async function linkAllBins (
  depNodes: DependenciesGraphNode[],
  depGraph: DependenciesGraph,
  opts: {
    optional: boolean,
    warn: (message: string) => void,
  },
) {
  return Promise.all(
    depNodes.map((depNode) => limitLinking(async () => {
      const childrenToLink = opts.optional
          ? depNode.children
          : R.keys(depNode.children)
            .reduce((nonOptionalChildren, childAlias) => {
              if (!depNode.optionalDependencies.has(childAlias)) {
                nonOptionalChildren[childAlias] = depNode.children[childAlias]
              }
              return nonOptionalChildren
            }, {})

      const pkgs = await Promise.all(
        R.keys(childrenToLink)
          .filter((alias) => depGraph[childrenToLink[alias]].hasBin && depGraph[childrenToLink[alias]].installable)
          .map(async (alias) => {
            const dep = depGraph[childrenToLink[alias]]
            return {
              location: dep.peripheralLocation,
              manifest: (await dep.fetchingRawManifest) || await readPackageFromDir(dep.peripheralLocation),
            }
          }),
      )

      const binPath = path.join(depNode.peripheralLocation, 'node_modules', '.bin')
      await linkBinsOfPackages(pkgs, binPath, {warn: opts.warn})

      // link also the bundled dependencies` bins
      if (depNode.hasBundledDependencies) {
        const bundledModules = path.join(depNode.peripheralLocation, 'node_modules')
        await linkBins(bundledModules, binPath, {warn: opts.warn})
      }
    })),
  )
}

async function linkAllModules (
  depNodes: DependenciesGraphNode[],
  depGraph: DependenciesGraph,
  opts: {
    optional: boolean,
  },
) {
  return Promise.all(
    depNodes
      .filter((depNode) => !depNode.independent)
      .map((depNode) => limitLinking(async () => {
        const childrenToLink = opts.optional
          ? depNode.children
          : R.keys(depNode.children)
            .reduce((nonOptionalChildren, childAlias) => {
              if (!depNode.optionalDependencies.has(childAlias)) {
                nonOptionalChildren[childAlias] = depNode.children[childAlias]
              }
              return nonOptionalChildren
            }, {})

        await Promise.all(
          R.keys(childrenToLink)
            .map(async (alias) => {
              const pkg = depGraph[childrenToLink[alias]]
              if (!pkg.installable) return
              await symlinkDependencyTo(alias, pkg.peripheralLocation, depNode.modules)
            }),
        )
      })),
  )
}
