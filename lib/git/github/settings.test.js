import { beforeAll, describe, expect, test } from 'vitest';

import { migrations } from '../../../migrations/index.js';
import { migrate } from '../../core/db/migrate.js';
import { getTestDatabase } from '../../test/helpers.js';

import { getGitHubInstallation, updateInstallationName } from './settings.js';

const db = getTestDatabase('github-settings');

beforeAll(async () => {
  await migrate(db, migrations);
});

describe('updateInstallationName()', () => {
  const installation = { id: 202, owner: 'sveltia', name: 'site', repositoryId: 1001 };

  test('follows a rename, by the repository’s ID', async () => {
    await expect(
      updateInstallationName(db, installation, [{ id: 1001, full_name: 'sveltia/website' }]),
    ).resolves.toEqual({ ...installation, name: 'website' });
    await expect(getGitHubInstallation(db)).resolves.toMatchObject({ name: 'website' });
  });

  test('learns an ID unknown when the app was installed', async () => {
    await expect(
      updateInstallationName(db, { ...installation, repositoryId: 0 }, [
        { id: 1001, full_name: 'sveltia/site' },
      ]),
    ).resolves.toEqual(installation);
  });

  test('leaves the installation as it is when nothing has changed', async () => {
    await expect(
      updateInstallationName(db, installation, [{ id: 1001, full_name: 'sveltia/site' }]),
    ).resolves.toBe(installation);
  });
});
