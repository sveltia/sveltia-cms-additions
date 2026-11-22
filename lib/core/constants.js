import pkg from '../../package.json' with { type: 'json' };

/**
 * Human-readable product name.
 */
export const PRODUCT_NAME = 'Sveltia CMS Additions';

/**
 * Name of the npm package.
 */
export const PACKAGE_NAME = pkg.name;

/**
 * Version of the npm package.
 */
export const PACKAGE_VERSION = pkg.version;

/**
 * Major version of the REST API, served under `/v1`.
 */
export const API_VERSION = 1;

/**
 * Version of the password key derivation, which the CMS must implement exactly.
 */
export const KDF_VERSION = 'v1';
