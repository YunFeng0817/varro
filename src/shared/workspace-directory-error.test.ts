import { describe, expect, it } from 'vitest';
import {
  isMissingWorkspaceDirectoryMessage,
  workspaceDirectoryRecoveryMessage,
} from './workspace-directory-error';

describe('missing workspace directory errors', () => {
  it.each([
    '404 Location not found',
    '404 {"message":"Location not found: /repo"}',
    '404\nLocation not found',
  ])('recognizes %s', (message) => {
    expect(isMissingWorkspaceDirectoryMessage(message)).toBe(true);
  });
  it.each([
    '404 Session not found',
    '404 route not found',
    '401 Location not found',
    '500 Location not found',
    'Location not found',
  ])('does not treat %s as a missing directory', (message) => {
    expect(isMissingWorkspaceDirectoryMessage(message)).toBe(false);
  });
  it('provides recovery instructions without claiming the history was removed', () => {
    expect(workspaceDirectoryRecoveryMessage('/old/repo')).toContain('/old/repo');
    expect(workspaceDirectoryRecoveryMessage('/old/repo')).toContain('Restore the folder');
    expect(workspaceDirectoryRecoveryMessage('/old/repo')).toContain(
      'not been deleted or relocated'
    );
  });
});
