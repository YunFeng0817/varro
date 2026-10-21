import { describe, expect, it } from 'vitest';
import { getOpenCodeApiCapabilities } from './opencode-api-capabilities';

describe('optional OpenCode API capabilities', () => {
  it('does not infer new capabilities from an existing session PATCH route', () => {
    expect(
      getOpenCodeApiCapabilities({
        paths: {
          '/api/session/{sessionID}': {
            patch: {
              requestBody: {
                content: {
                  'application/json': { schema: { properties: { title: { type: 'string' } } } },
                },
              },
            },
          },
        },
      })
    ).toEqual({ sessionArchiving: false, savedPermissionEditing: false });
  });

  it('recognizes both operations through referenced and composed request schemas', () => {
    expect(
      getOpenCodeApiCapabilities({
        paths: {
          '/api/session/{sessionID}': {
            patch: {
              requestBody: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Session.Update' } },
                },
              },
            },
          },
          '/api/permission/saved/{id}': {
            patch: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      allOf: [
                        { properties: { action: { type: 'string' } } },
                        { properties: { resource: { type: 'string' } } },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: { 'Session.Update': { properties: { archived: { type: 'boolean' } } } },
        },
      })
    ).toEqual({ sessionArchiving: true, savedPermissionEditing: true });
  });

  it.each([
    undefined,
    null,
    {},
    { paths: {} },
    { paths: { '/api/permission/saved/{id}': { get: {} } } },
  ])('keeps optional features disabled for missing contracts: %j', (spec) => {
    expect(getOpenCodeApiCapabilities(spec)).toEqual({
      sessionArchiving: false,
      savedPermissionEditing: false,
    });
  });

  it('bounds cyclic references', () => {
    expect(
      getOpenCodeApiCapabilities({
        paths: {
          '/api/session/{sessionID}': {
            patch: {
              requestBody: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Cycle' } },
                },
              },
            },
          },
        },
        components: { schemas: { Cycle: { $ref: '#/components/schemas/Cycle' } } },
      }).sessionArchiving
    ).toBe(false);
  });
});
