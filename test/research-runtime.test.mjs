import test from 'node:test';
import assert from 'node:assert/strict';

import { ResearchRuntime } from '../dist/tui/native/research-runtime.js';

test('ResearchRuntime fans out shard work and synthesizes the collected evidence', async () => {
  const runtime = new ResearchRuntime();
  const toolCalls = [];
  const shardUpdates = [];

  const result = await runtime.run(
    {
      task: 'omo/omc를 비교 리서치해줘',
      subjects: ['omo', 'omc'],
      includeLocalDocs: false,
      maxConcurrency: 2,
      runTool: async (name, args) => {
        toolCalls.push({ name, args });
        if (name === 'web_search') {
          return {
            output: `Search query: ${args.query}\nResults: 1`,
            metadata: {
              results: [{ url: `https://example.com/${args.query}` }],
            },
          };
        }
        if (name === 'web_fetch') {
          return {
            output: `Fetched ${args.url}`,
          };
        }
        return {
          output: '',
        };
      },
      synthesize: async ({ shards }) => shards.map((shard) => shard.subject).join(', '),
    },
    {
      onShardComplete: (shard, completed, total) => {
        shardUpdates.push({ subject: shard.subject, completed, total });
      },
    },
  );

  assert.equal(result.output, 'omo, omc');
  assert.equal(result.shards.length, 2);
  assert.deepEqual(shardUpdates.map((entry) => entry.completed), [1, 2]);
  assert.equal(toolCalls.filter((call) => call.name === 'web_search').length, 2);
  assert.equal(toolCalls.filter((call) => call.name === 'web_fetch').length, 2);
});
