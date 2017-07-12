import test = require('tape')
import {installPkgs} from 'supi'
import {prepare, testDefaults} from './utils'
import getList = require('../src')

test('one package depth 0', async t => {
  prepare(t)

  await installPkgs(['rimraf@2.5.1'], testDefaults())
  await installPkgs(['is-positive@1.0.0'], testDefaults({saveDev: true}))
  await installPkgs(['is-negative@1.0.0'], testDefaults({saveOptional: true}))

  const list = await getList(process.cwd(), {depth: 0})

  t.deepEqual(list, [
      {
        pkg: {
          name: 'rimraf',
          version: '2.5.1',
        }
      },
      {
        pkg: {
          name: 'is-positive',
          version: '1.0.0',
        }
      },
      {
        pkg: {
          name: 'is-negative',
          version: '1.0.0',
        }
      },
  ])

  t.end()
})

test('one package depth 1', async t => {
  prepare(t)

  await installPkgs(['rimraf@2.5.1'], testDefaults())

  const list = await getList(process.cwd(), {depth: 1})

  t.deepEqual(list, [
      {
        pkg: {
          name: 'rimraf',
          version: '2.5.1',
        },
        dependencies: [
          {
            pkg: {
              name: 'glob',
              version: '6.0.4',
            }
          }
        ]
      }
  ])

  t.end()
})

test('only prod depth 0', async t => {
  prepare(t)

  await installPkgs(['rimraf@2.5.1'], testDefaults())
  await installPkgs(['is-negative'], testDefaults({saveDev: true}))
  await installPkgs(['is-positive'], testDefaults({saveOptional: true}))

  const list = await getList(process.cwd(), {depth: 0, only: 'prod'})

  t.deepEqual(list, [
      {
        pkg: {
          name: 'rimraf',
          version: '2.5.1',
        },
      }
  ])

  t.end()
})

test('only dev depth 0', async t => {
  prepare(t)

  await installPkgs(['rimraf@2.5.1'], testDefaults({saveDev: true}))
  await installPkgs(['is-negative'], testDefaults())
  await installPkgs(['is-positive'], testDefaults({saveOptional: true}))

  const list = await getList(process.cwd(), {depth: 0, only: 'dev'})

  t.deepEqual(list, [
      {
        pkg: {
          name: 'rimraf',
          version: '2.5.1',
        },
      }
  ])

  t.end()
})
