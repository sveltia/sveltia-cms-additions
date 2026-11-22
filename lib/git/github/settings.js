import { getSecretSetting, getSetting, setSecretSetting, setSetting } from '../../core/settings.js';

/**
 * @import { Database, DataKeys } from '../../types.js';
 */

/**
 * Public details of the GitHub App, stored as a plain setting.
 * @typedef {object} GitHubAppInfo
 * @property {number} id App ID.
 * @property {string} slug App slug, used in its URLs.
 * @property {string} clientId OAuth client ID.
 * @property {string} owner Account that owns the app.
 * @property {'User' | 'Organization'} [ownerType] Type of the account that owns the app.
 * @property {string} htmlUrl App page on GitHub.
 */

/**
 * Installation of the app on the site’s repository.
 * @typedef {object} GitHubInstallation
 * @property {number} id Installation ID.
 * @property {string} owner Repository owner.
 * @property {string} name Repository name.
 * @property {number} repositoryId Repository ID.
 */

/**
 * Everything needed to act as the app on the site’s repository.
 * @typedef {GitHubAppInfo & { privateKey: string, clientSecret: string, installation:
 * GitHubInstallation }} GitHubConfig
 */

/**
 * Setting keys.
 */
export const GITHUB_SETTINGS = {
  app: 'github_app',
  installation: 'github_installation',
  privateKey: 'github_app_private_key',
  clientSecret: 'github_app_client_secret',
  webhookSecret: 'github_app_webhook_secret',
};

/**
 * Get the public details of the app, if one is registered.
 * @param {Database} db Database.
 * @returns {Promise<GitHubAppInfo | undefined>} App.
 */
export const getGitHubAppInfo = (db) => getSetting(db, GITHUB_SETTINGS.app);

/**
 * Get the installation on the site’s repository, if the app is installed.
 * @param {Database} db Database.
 * @returns {Promise<GitHubInstallation | undefined>} Installation.
 */
export const getGitHubInstallation = (db) => getSetting(db, GITHUB_SETTINGS.installation);

/**
 * Get the URL of the app’s settings on GitHub, where its private keys are generated.
 * @param {GitHubAppInfo} info App.
 * @returns {string} URL.
 */
export const getAppSettingsUrl = ({ slug, owner, ownerType }) =>
  ownerType === 'Organization'
    ? `https://github.com/organizations/${owner}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;

/**
 * Store a newly registered app.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {object} args Arguments.
 * @param {GitHubAppInfo} args.info Public details.
 * @param {string} args.privateKey PEM-encoded private key, in PKCS#8.
 * @param {string} args.clientSecret OAuth client secret.
 * @param {string} args.webhookSecret Webhook secret.
 * @returns {Promise<void>}
 */
export const saveGitHubApp = async (
  db,
  keys,
  { info, privateKey, clientSecret, webhookSecret },
) => {
  await setSecretSetting(db, keys, GITHUB_SETTINGS.privateKey, privateKey);
  await setSecretSetting(db, keys, GITHUB_SETTINGS.clientSecret, clientSecret);
  await setSecretSetting(db, keys, GITHUB_SETTINGS.webhookSecret, webhookSecret);
  await setSetting(db, GITHUB_SETTINGS.app, info);
};

/**
 * Store the installation on the site’s repository.
 * @param {Database} db Database.
 * @param {GitHubInstallation} installation Installation.
 * @returns {Promise<void>}
 */
export const saveGitHubInstallation = (db, installation) =>
  setSetting(db, GITHUB_SETTINGS.installation, installation);

/**
 * Get everything needed to act as the app, if it’s registered, installed and its secrets can be
 * decrypted.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @returns {Promise<GitHubConfig | undefined>} Configuration.
 */
export const getGitHubConfig = async (db, keys) => {
  const [info, installation, privateKey, clientSecret] = await Promise.all([
    getGitHubAppInfo(db),
    getGitHubInstallation(db),
    getSecretSetting(db, keys, GITHUB_SETTINGS.privateKey),
    getSecretSetting(db, keys, GITHUB_SETTINGS.clientSecret),
  ]);

  if (!info || !installation || !privateKey || !clientSecret) {
    return undefined;
  }

  return { ...info, installation, privateKey, clientSecret };
};

/**
 * Keep the repository’s name up to date after it has been renamed, or moved to another owner the
 * app is also installed on. Tokens are minted by the repository’s ID, which doesn’t change, and
 * GitHub reports its current name with each one.
 * @param {Database} db Database.
 * @param {GitHubInstallation} installation Installation, as stored.
 * @param {{ id: number, full_name: string }[]} repositories Repositories a token was minted for.
 * @returns {Promise<GitHubInstallation>} Installation, with the current name.
 */
export const updateInstallationName = async (db, installation, repositories) => {
  // An ID unknown when the app was installed is learned from the one repository a token was minted
  // for by name
  const repository = installation.repositoryId
    ? repositories.find(({ id }) => id === installation.repositoryId)
    : repositories.find((_repository, _index, all) => all.length === 1);
  const [owner, name] = repository?.full_name.split('/') ?? [];

  if (
    !repository ||
    !owner ||
    !name ||
    (owner === installation.owner &&
      name === installation.name &&
      repository.id === installation.repositoryId)
  ) {
    return installation;
  }

  const updated = { ...installation, owner, name, repositoryId: repository.id };

  await saveGitHubInstallation(db, updated);

  return updated;
};
