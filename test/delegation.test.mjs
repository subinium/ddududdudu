import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DelegationRuntime } from '../dist/core/delegation.js'

const createProvider = (provider, tokenType = 'apikey', source = 'env') => {
  return [provider, { token: 'test-token', tokenType, source }]
}

const createRuntime = (overrides = {}) => {
  return new DelegationRuntime({
    cwd: '/tmp/ddudu-test',
    availableProviders: new Map(),
    ...overrides,
  })
}

describe('DelegationRuntime listAvailableModes', () => {
  it('normalizes claude and codex aliases into supported providers', () => {
    const runtime = createRuntime({
      availableProviders: new Map([
        createProvider('claude', 'apikey', 'auth-cli'),
        createProvider('codex', 'apikey', 'auth-cli'),
      ]),
    })

    assert.deepEqual(runtime.listAvailableModes(), ['jennie', 'lisa', 'rosé', 'jisoo'])
  })

  it('filters out stale provider auth entries', () => {
    const runtime = createRuntime({
      availableProviders: new Map([createProvider('openai', 'apikey', 'env:stale')]),
    })

    assert.deepEqual(runtime.listAvailableModes(), [])
  })
})

describe('DelegationRuntime resolveMode', () => {
  it('returns preferred mode when available', () => {
    const runtime = createRuntime()
    runtime.listAvailableModes = () => ['jennie', 'lisa']

    assert.equal(runtime.resolveMode('jennie', 'planning'), 'jennie')
  })

  it('falls back by PURPOSE_FALLBACKS ordering for planning purpose', () => {
    const runtime = createRuntime()
    runtime.listAvailableModes = () => ['jennie', 'rosé']

    assert.equal(runtime.resolveMode(undefined, 'planning'), 'rosé')
  })

  it('throws when no delegated modes are available', () => {
    const runtime = createRuntime()
    runtime.listAvailableModes = () => []

    assert.throws(() => runtime.resolveMode(undefined, 'execution'), /No delegated modes available/)
  })
})

describe('DelegationRuntime run purpose inference and errors', () => {
  it('infers design purpose from UI and typography keywords', async () => {
    const runtime = createRuntime()
    let inferredPurpose
    runtime.resolveMode = (_preferredMode, purpose) => {
      inferredPurpose = purpose
      throw new Error('STOP_AFTER_PURPOSE')
    }

    await assert.rejects(runtime.run({ prompt: 'Improve UI layout spacing and typography' }), /STOP_AFTER_PURPOSE/)
    assert.equal(inferredPurpose, 'design')
  })

  it('infers planning purpose from architecture and edge case keywords', async () => {
    const runtime = createRuntime()
    let inferredPurpose
    runtime.resolveMode = (_preferredMode, purpose) => {
      inferredPurpose = purpose
      throw new Error('STOP_AFTER_PURPOSE')
    }

    await assert.rejects(
      runtime.run({ prompt: 'Write an architecture plan with edge case tradeoff notes' }),
      /STOP_AFTER_PURPOSE/,
    )
    assert.equal(inferredPurpose, 'planning')
  })

  it('infers oracle purpose from second-opinion keywords', async () => {
    const runtime = createRuntime()
    let inferredPurpose
    runtime.resolveMode = (_preferredMode, purpose) => {
      inferredPurpose = purpose
      throw new Error('STOP_AFTER_PURPOSE')
    }

    await assert.rejects(runtime.run({ prompt: 'Need an oracle second opinion from a stronger model' }), /STOP_AFTER_PURPOSE/)
    assert.equal(inferredPurpose, 'oracle')
  })

  it('throws no-auth error when selected mode provider is missing', async () => {
    const runtime = createRuntime({
      availableProviders: new Map(),
    })
    runtime.listAvailableModes = () => ['lisa']

    await assert.rejects(
      runtime.run({ prompt: 'Execute the implementation quickly' }),
      /No auth available for delegated mode lisa \(openai\)/,
    )
  })
})

describe('DelegationRuntime maxTokens fallback chain', () => {
  it('checks request.maxTokens first before config fallback', async () => {
    const runtime = createRuntime({
      availableProviders: new Map([createProvider('openai', 'invalid', 'env')]),
      defaultMaxTokens: 2222,
    })
    const request = {
      prompt: 'Research this area',
      purpose: 'research',
      preferredMode: 'lisa',
      get maxTokens() {
        throw new Error('REQUEST_MAXTOKENS_READ')
      },
    }

    await assert.rejects(runtime.run(request), /REQUEST_MAXTOKENS_READ/)
  })

  it('falls back to config.defaultMaxTokens when request.maxTokens is absent', async () => {
    const runtime = createRuntime({
      availableProviders: new Map([createProvider('openai', 'invalid', 'env')]),
    })
    Object.defineProperty(runtime.config, 'defaultMaxTokens', {
      configurable: true,
      get() {
        throw new Error('CONFIG_MAXTOKENS_READ')
      },
    })

    await assert.rejects(
      runtime.run({
        prompt: 'Research this area',
        purpose: 'research',
        preferredMode: 'lisa',
      }),
      /CONFIG_MAXTOKENS_READ/,
    )
  })

  it('keeps the hardcoded 8192 fallback in delegation runtime', async () => {
    const source = await readFile(new URL('../dist/core/delegation.js', import.meta.url), 'utf8')

    assert.match(source, /maxTokens:\s*request\.maxTokens\s*\?\?\s*this\.config\.defaultMaxTokens\s*\?\?\s*8192/)
  })
})

describe('DelegationRuntime maybeCreateWorkspace', () => {
  it('returns null when worktree manager is absent', async () => {
    const runtime = createRuntime({ worktreeManager: null })

    const workspace = await runtime.maybeCreateWorkspace({
      auth: { token: 'x', tokenType: 'apikey', source: 'env' },
      provider: 'openai',
      purpose: 'execution',
      baseCwd: '/tmp/ddudu-test',
      label: 'workspace',
      forceIsolation: false,
      readOnly: false,
    })

    assert.equal(workspace, null)
  })

  it('returns null for read-only research when isolation is not forced', async () => {
    let createCalled = false
    const runtime = createRuntime({
      worktreeManager: {
        create: async () => {
          createCalled = true
          return { path: '/tmp/workspace', kind: 'worktree' }
        },
      },
    })

    const workspace = await runtime.maybeCreateWorkspace({
      auth: { token: 'x', tokenType: 'apikey', source: 'env' },
      provider: 'openai',
      purpose: 'research',
      baseCwd: '/tmp/ddudu-test',
      label: 'workspace',
      forceIsolation: false,
      readOnly: true,
    })

    assert.equal(workspace, null)
    assert.equal(createCalled, false)
  })
})
