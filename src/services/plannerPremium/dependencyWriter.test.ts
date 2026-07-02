import { describe, expect, it } from 'vitest'
import { dependencyLagSeconds, dependencyLagTenthsOfMinute, dependencyLinkTypeValue, isLagRelatedFailure, isLinkTypeRelatedFailure } from './dependencyWriter'
import type { PoTaskDependency } from '../../models/projectOnline.types'

const dependency = (lag?: number): PoTaskDependency => ({
  DependencyId: 'D1',
  ProjectId: 'P1',
  PredecessorTaskId: 'T1',
  SuccessorTaskId: 'T2',
  Lag: lag,
})

describe('dependencyLinkTypeValue', () => {
  it('uses Dataverse option-set values from msdyn_projecttaskdependencylinktype', () => {
    expect(dependencyLinkTypeValue('FF')).toBe(0)
    expect(dependencyLinkTypeValue('FS')).toBe(1)
    expect(dependencyLinkTypeValue('SF')).toBe(2)
    expect(dependencyLinkTypeValue('SS')).toBe(3)
  })

  it('defaults missing source type to FS', () => {
    expect(dependencyLinkTypeValue(undefined)).toBe(1)
  })
})

describe('dependencyLagTenthsOfMinute', () => {
  it('keeps Project Server numeric lag as tenths of a minute', () => {
    expect(dependencyLagTenthsOfMinute(dependency(456), true)).toBe(456)
  })

  it('omits lag when the import option is disabled', () => {
    expect(dependencyLagTenthsOfMinute(dependency(456), false)).toBeNull()
  })

  it('omits zero lag', () => {
    expect(dependencyLagTenthsOfMinute(dependency(0), true)).toBeNull()
  })
})

describe('dependencyLagSeconds', () => {
  it('converts Project Server lag tenths-of-minute to Dataverse dependency lag seconds', () => {
    expect(dependencyLagSeconds(dependency(4800), true)).toBe(28800)
  })

  it('keeps lead negative when converting to seconds', () => {
    expect(dependencyLagSeconds(dependency(-4800), true)).toBe(-28800)
  })
})

describe('isLagRelatedFailure', () => {
  it('matches validation errors naming the lag attribute', () => {
    expect(isLagRelatedFailure('Attribute msdyn_projecttaskdependencylinklag is not valid for create')).toBe(true)
    expect(isLagRelatedFailure('The value for Lag is out of range')).toBe(true)
  })

  it('does not match transient failures, so they keep the original payload', () => {
    expect(isLagRelatedFailure('Object reference not set to an instance of an object')).toBe(false)
    expect(isLagRelatedFailure('Rate limit is exceeded. Try again in 26 seconds.')).toBe(false)
    expect(isLagRelatedFailure('Another operation set is currently executing for this project')).toBe(false)
  })

  it('does not match on the word flag', () => {
    expect(isLagRelatedFailure('Feature flag disabled for this tenant')).toBe(false)
  })
})

describe('isLinkTypeRelatedFailure', () => {
  it('matches validation errors naming the link type attribute or value', () => {
    expect(isLinkTypeRelatedFailure('Invalid value for msdyn_projecttaskdependencylinktype')).toBe(true)
    expect(isLinkTypeRelatedFailure('The specified link type is not supported')).toBe(true)
    expect(isLinkTypeRelatedFailure('Unsupported DependencyType for this operation')).toBe(true)
  })

  it('does not match transient failures, so they keep the original payload', () => {
    expect(isLinkTypeRelatedFailure('Object reference not set to an instance of an object')).toBe(false)
    expect(isLinkTypeRelatedFailure('Gateway timeout')).toBe(false)
  })
})
