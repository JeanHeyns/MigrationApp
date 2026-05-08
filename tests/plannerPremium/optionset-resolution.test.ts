import assert from 'node:assert/strict'
import test from 'node:test'

import type { GlobalOptionSetMeta, ResolverPlan } from '../../src/models/dataOnly.types.ts'
import { buildResolverMap, clearResolverCaches } from '../../src/services/plannerPremium/resolverFactory.ts'

const statusChoices: GlobalOptionSetMeta = {
  name: 'exp_status_choices',
  displayName: 'Status Choices',
  options: [
    { value: 100000000, label: 'Green', labels: ['Green', 'Groen'] },
    { value: 100000001, label: 'Amber', labels: ['Amber'] },
  ],
}

test('shared global option set resolves multiple Dataverse fields by optionSetName', async () => {
  clearResolverCaches()
  const fetched: string[] = []
  const plan: ResolverPlan = {
    fields: [
      {
        poFieldName: 'BudgetStatus',
        dvLogicalName: 'exp_budget_status',
        dvType: 'Picklist',
        optionSetName: 'exp_status_choices',
        optionSetIsGlobal: true,
      },
      {
        poFieldName: 'ResourceStatus',
        dvLogicalName: 'exp_resource_status',
        dvType: 'Picklist',
        optionSetName: 'exp_status_choices',
        optionSetIsGlobal: true,
      },
    ],
  }

  const { resolvers, warnings } = await buildResolverMap(plan, {
    fetchGlobalOptionSet: async name => {
      fetched.push(name)
      return name === 'exp_status_choices' ? statusChoices : null
    },
  })

  assert.deepEqual(warnings, [])
  assert.equal(resolvers.get('BudgetStatus')?.resolve('Amber').value, 100000001)
  assert.equal(resolvers.get('ResourceStatus')?.resolve('Groen').value, 100000000)
  assert.deepEqual(fetched, ['exp_status_choices'])
})

test('local option set resolves from attribute metadata without global fetch', async () => {
  clearResolverCaches()
  const plan: ResolverPlan = {
    fields: [
      {
        poFieldName: 'Codes',
        dvLogicalName: 'exp_codes',
        dvType: 'Picklist',
        optionSetName: 'exp_codes_local',
        optionSetIsGlobal: false,
        optionSetOptions: [
          { value: 100000010, label: 'OP.HK', labels: ['OP.HK'] },
        ],
      },
      {
        poFieldName: 'Codesmultiselect',
        dvLogicalName: 'exp_codes_multiselect',
        dvType: 'MultiSelectPicklist',
        optionSetName: 'exp_codes_multi_local',
        optionSetIsGlobal: false,
        optionSetOptions: [
          { value: 100000011, label: 'BA.GRE', labels: ['BA.GRE'] },
          { value: 100000012, label: 'BA.YO', labels: ['BA.YO'] },
          { value: 100000013, label: 'OP.HK', labels: ['OP.HK'] },
        ],
      },
    ],
  }

  const { resolvers, warnings } = await buildResolverMap(plan, {
    fetchGlobalOptionSet: async () => {
      throw new Error('global fetch should not be called for local option sets')
    },
  })

  assert.deepEqual(warnings, [])
  assert.equal(resolvers.get('Codes')?.resolve('OP.HK').value, 100000010)
  assert.equal(resolvers.get('Codesmultiselect')?.resolve('BA.GRE, BA.YO, OP.HK').value, '100000011,100000012,100000013')
})

test('local option set without metadata reports option-set root cause', async () => {
  clearResolverCaches()
  const plan: ResolverPlan = {
    fields: [
      {
        poFieldName: 'Codes',
        dvLogicalName: 'exp_codes',
        dvType: 'Picklist',
        optionSetName: 'exp_codes_local',
        optionSetIsGlobal: false,
      },
    ],
  }

  const { resolvers, warnings } = await buildResolverMap(plan, {
    fetchGlobalOptionSet: async () => null,
  })
  const result = resolvers.get('Codes')?.resolve('OP.HK')

  assert.equal(warnings[0]?.type, 'option_set_fetch_failed')
  assert.equal(result?.status, 'unresolved')
  assert.match(result?.failureReason ?? '', /local Dataverse field "exp_codes"/)
})
